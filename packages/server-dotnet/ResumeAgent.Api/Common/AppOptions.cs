// 应用配置：统一走 ASP.NET Core 配置管道（环境变量 / appsettings.json / 命令行 / 测试均可覆盖）。
// 键名与 packages/server 的 .env 逐字一致，保证两个后端共用同一份 .env、可同时启动。
// 配置在进程生命周期内不变，故启动时绑定一次，以 IOptions<T> 注入，不做热重载。

using Microsoft.Extensions.Configuration;

namespace ResumeAgent.Api.Common;

public sealed class AppOptions
{
    public string Port { get; init; } = "4000";
    public string? DatabaseUrl { get; init; }
    public string JwtSecret { get; init; } = "change_me_to_a_long_random_secret_string";
    public string[] ClientOrigins { get; init; } = ["http://localhost:5173"];
    public LlmEnvOptions Llm { get; init; } = new();
    public OcrOptions Ocr { get; init; } = new();

    /// <summary>从配置管道绑定（默认值与 Node 版 .env 读取逻辑逐字对齐）</summary>
    public static AppOptions Bind(IConfiguration config) => new()
    {
        Port = config["PORT"] ?? "4000",
        DatabaseUrl = config["DATABASE_URL"],
        JwtSecret = config["JWT_SECRET"] ?? "change_me_to_a_long_random_secret_string",
        ClientOrigins = (config["CLIENT_ORIGIN"] ?? "http://localhost:5173")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
        Llm = new LlmEnvOptions
        {
            Provider = config["LLM_PROVIDER"],
            ApiKey = config["LLM_API_KEY"]?.Trim(),
            BaseUrl = config["LLM_BASE_URL"]?.Trim(),
            Model = config["LLM_MODEL"]?.Trim(),
        },
        Ocr = new OcrOptions
        {
            EnvName = config["RESUME_OCR_ENV"] ?? "resume_ocr",
            CondaExe = config["CONDA_EXE"] ?? "conda",
        },
    };
}

/// <summary>.env 兜底配置：未建任何 profile 时使用（对齐 llm.ts 的 readEnvConfig）</summary>
public sealed class LlmEnvOptions
{
    public string? Provider { get; init; }
    public string? ApiKey { get; init; }
    public string? BaseUrl { get; init; }
    public string? Model { get; init; }
}

/// <summary>OCR 外部进程配置</summary>
public sealed class OcrOptions
{
    public string EnvName { get; init; } = "resume_ocr";
    public string CondaExe { get; init; } = "conda";
}