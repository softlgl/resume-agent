// LLM 配置模型与 provider 预设（对齐 services/llm.ts 的 DEFAULTS 与 mergeAndValidate）

namespace ResumeAgent.Api.Services.Llm;

public enum LlmProvider
{
    Openai, Deepseek, Doubao, Qwen, Ollama, Lmstudio, Vllm,
}

public class LlmConfig
{
    public LlmProvider Provider { get; set; }
    public string ApiKey { get; set; } = "";      // 本地模型可能为空字符串
    public string BaseUrl { get; set; } = "";
    public string Model { get; set; } = "";
    public int MaxContext { get; set; }           // 输入上下文上限（token）
    public int MaxOutput { get; set; }            // 输出上限（token）
}

public class LlmProfile : LlmConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
}

public static class LlmDefaults
{
    // 各家默认 base URL / model / 上下文与输出上限
    public static readonly Dictionary<LlmProvider, (string BaseUrl, string Model, int MaxContext, int MaxOutput)> All =
        new()
        {
            [LlmProvider.Openai] = ("https://api.openai.com/v1", "gpt-4o-mini", 128000, 16384),
            [LlmProvider.Deepseek] = ("https://api.deepseek.com/v1", "deepseek-chat", 128000, 8192),
            [LlmProvider.Doubao] = ("https://ark.cn-beijing.volces.com/api/v3", "doubao-pro-4k", 128000, 8192),
            [LlmProvider.Qwen] = ("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", 131072, 8192),
            [LlmProvider.Ollama] = ("http://localhost:11434/v1", "qwen2.5:7b", 32768, 4096),
            [LlmProvider.Lmstudio] = ("http://localhost:1234/v1", "qwen2.5-7b", 32768, 4096),
            [LlmProvider.Vllm] = ("http://localhost:8000/v1", "qwen2.5-7b", 32768, 4096),
        };

    public static bool IsLocal(LlmProvider p) =>
        p is LlmProvider.Ollama or LlmProvider.Lmstudio or LlmProvider.Vllm;

    public static string ProviderName(LlmProvider p) => p switch
    {
        LlmProvider.Openai => "openai",
        LlmProvider.Deepseek => "deepseek",
        LlmProvider.Doubao => "doubao",
        LlmProvider.Qwen => "qwen",
        LlmProvider.Ollama => "ollama",
        LlmProvider.Lmstudio => "lmstudio",
        LlmProvider.Vllm => "vllm",
        _ => "unknown",
    };

    /// <summary>字符串 → provider；未知返回 null（等价 TS 的运行时宽松解析）</summary>
    public static LlmProvider? Parse(string? name) => name?.ToLowerInvariant() switch
    {
        "openai" => LlmProvider.Openai,
        "deepseek" => LlmProvider.Deepseek,
        "doubao" => LlmProvider.Doubao,
        "qwen" => LlmProvider.Qwen,
        "ollama" => LlmProvider.Ollama,
        "lmstudio" => LlmProvider.Lmstudio,
        "vllm" => LlmProvider.Vllm,
        _ => null,
    };

    /// <summary>对齐 mergeAndValidate：兜底默认值 + 云端 provider 必须有 apiKey；不可用返回 null</summary>
    public static LlmConfig? MergeAndValidate(LlmConfig baseCfg)
    {
        var def = All[baseCfg.Provider];
        var merged = new LlmConfig
        {
            Provider = baseCfg.Provider,
            ApiKey = baseCfg.ApiKey ?? "",
            BaseUrl = string.IsNullOrWhiteSpace(baseCfg.BaseUrl) ? def.BaseUrl : baseCfg.BaseUrl,
            Model = string.IsNullOrWhiteSpace(baseCfg.Model) ? def.Model : baseCfg.Model,
            MaxContext = Math.Max(1, baseCfg.MaxContext > 0 ? baseCfg.MaxContext : def.MaxContext),
            MaxOutput = Math.Max(1, baseCfg.MaxOutput > 0 ? baseCfg.MaxOutput : def.MaxOutput),
        };
        if (!IsLocal(merged.Provider) && string.IsNullOrEmpty(merged.ApiKey)) return null;
        return merged;
    }
}
