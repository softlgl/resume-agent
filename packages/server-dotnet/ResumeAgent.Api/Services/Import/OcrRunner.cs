// OCR 封装（对齐 services/ocripy.ts）：调 conda 虚拟环境里的 rapidocr(onnxruntime) 识别图片
// 流程：找 conda → 确保 resume_ocr 环境存在 → 确认依赖已装 → 用该环境 python 运行 scripts/ocr.py
// ready 状态缓存，避免每次请求重复探测/安装。

using System.Diagnostics;
using System.Text.Json;

namespace ResumeAgent.Api.Services.Import;

public class OcrResult
{
    public bool Ok { get; init; }
    public string Text { get; init; } = "";
    public string? Error { get; init; }
}

public class OcrRunner(ILogger<OcrRunner> logger)
{
    private static readonly string ScriptPath = FindScriptPath();
    private static readonly string EnvName = Environment.GetEnvironmentVariable("RESUME_OCR_ENV") ?? "resume_ocr";
    private static readonly object Lock = new();
    private static string _ready = "untried"; // untried | ready | failed
    private static string _lastError = "";

    private static string CondaBin => Environment.GetEnvironmentVariable("CONDA_EXE") ?? "conda";

    private static string FindScriptPath()
    {
        // 复用 Node server 的 scripts/ocr.py：packages/server-dotnet/bin/... 向上找 packages/server/scripts/ocr.py
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "packages", "server", "scripts", "ocr.py");
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        return Path.Combine("packages", "server", "scripts", "ocr.py");
    }

    private static string CondaRun(string[] args, int timeoutMs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = CondaBin,
            Arguments = string.Join(' ', args.Select(Quote)),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
        };
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("无法启动 conda 进程");
        var stdout = p.StandardOutput.ReadToEndAsync().Result;
        var ok = p.WaitForExit(timeoutMs);
        if (!ok) { p.Kill(true); throw new TimeoutException("conda 命令超时"); }
        if (p.ExitCode != 0) throw new InvalidOperationException($"conda 退出码 {p.ExitCode}: {Truncate(p.StandardError.ReadToEndAsync().Result, 500)}");
        return stdout;
    }

    private static string Quote(string s) =>
        s.Contains(' ') ? $"\"{s}\"" : s;

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];

    private static bool EnvExists()
    {
        try
        {
            CondaRun(["env", "list"], 60000);
        }
        catch { return false; }
        try
        {
            CondaRun(["run", "-n", EnvName, "python", "--version"], 60000);
            return true;
        }
        catch { return false; }
    }

    private static bool IsInstalled()
    {
        try
        {
            CondaRun(["run", "-n", EnvName, "python", "-c", "import rapidocr, onnxruntime"], 60000);
            return true;
        }
        catch { return false; }
    }

    private static bool EnsureReady()
    {
        try
        {
            if (!EnvExists())
                CondaRun(["create", "-n", EnvName, "python", "-y", "-q"], 600000);
            if (!IsInstalled())
                CondaRun(["run", "-n", EnvName, "python", "-m", "pip", "install", "-q", "rapidocr", "onnxruntime"], 600000);
            _ready = "ready";
            return true;
        }
        catch (Exception ex)
        {
            _ready = "failed";
            _lastError = ex.Message;
            return false;
        }
    }

    /// <summary>调 python ocr.py <img1> <img2> ...，脚本 stdout 输出 JSON {"texts":[{pageIndex,text}]}</summary>
    public OcrResult RunOcr(IReadOnlyList<string> imagePaths)
    {
        if (imagePaths.Count == 0) return new OcrResult { Ok = false };
        lock (Lock)
        {
            if (_ready != "ready" && (_ready == "failed" || !EnsureReady()))
                return new OcrResult { Ok = false, Error = _lastError };

            try
            {
                var args = new List<string> { "run", "-n", EnvName, "python", ScriptPath };
                args.AddRange(imagePaths);
                var stdout = CondaRun([.. args], 180000);
                // conda run 可能输出激活横幅，取出第一个 { 到最后一个 } 的 JSON
                var start = stdout.IndexOf('{');
                var end = stdout.LastIndexOf('}');
                if (start < 0 || end <= start) return new OcrResult { Ok = false, Error = "OCR 输出无 JSON" };
                var data = JsonSerializer.Deserialize<OcrOutput>(stdout[start..(end + 1)]);
                if (data?.Texts is null) return new OcrResult { Ok = false, Error = "OCR 输出格式不符" };
                var text = string.Join("\n",
                    data.Texts.OrderBy(t => t.PageIndex).Select(t => t.Text ?? ""));
                return new OcrResult { Ok = true, Text = text };
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "[OCR] 执行失败");
                return new OcrResult { Ok = false, Error = ex.Message };
            }
        }
    }

    private sealed class OcrOutput
    {
        public List<OcrItem>? Texts { get; set; }
    }

    private sealed class OcrItem
    {
        public int PageIndex { get; set; }
        public string? Text { get; set; }
    }
}
