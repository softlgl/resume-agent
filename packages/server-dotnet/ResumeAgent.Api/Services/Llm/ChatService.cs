// 聊天服务（对齐 llm.ts 的 chat / chatStream）：
// - provider 策略：openai 用 response_format=json_schema；deepseek/doubao/qwen 用 json_object；本地模型无 response_format
//   非 openai 一律把 JSON Schema 文本注入 system 提示词（它们拿不到 json_schema，只能靠提示约束结构）
// - 所有 provider 统一走 RawOpenAiStream（自建请求体），原因见该文件头部注释
// - maxOutput clamp：调用方给的再大也被收敛到 profile.maxOutput

using System.Text.Json;

namespace ResumeAgent.Api.Services.Llm;

public class ChatService(ProfileSnapshotService profiles, ILogger<ChatService> logger)
{
    private const string JsonOnlySystemPrompt = "你必须严格输出 JSON，不要加任何其他文字、解释或 markdown 代码块。";

    /// <summary>该 provider 是否支持通过 response_format 传 json_schema（当前只有 openai 官方）。
    /// 这是「结构化输出走参数还是走提示词」的分水岭，只在此处判定一次。</summary>
    private static bool SupportsJsonSchemaParam(LlmProvider provider) => provider == LlmProvider.Openai;

    /// <summary>response_format 策略：openai 走 json_schema；其余云端走 json_object；本地模型无此参数</summary>
    private static OpenAiResponseFormat? ResolveResponseFormat(LlmProvider provider, string? jsonSchema)
    {
        if (string.IsNullOrEmpty(jsonSchema)) return null;
        if (SupportsJsonSchemaParam(provider))
            return new OpenAiResponseFormat("json_schema",
                new OpenAiJsonSchema("resume_analysis", JsonDocument.Parse(jsonSchema).RootElement.Clone(), true));
        return LlmDefaults.IsLocal(provider) ? null : new OpenAiResponseFormat("json_object"); // json_schema 会 400
    }

    /// <summary>把 JSON Schema 文本注入 system 提示词——供拿不到 json_schema 参数的 provider 约束输出结构。
    /// openai 走 response_format 参数，此处恒返回 null。</summary>
    private static string? BuildSchemaSystemPrompt(LlmProvider provider, string? jsonSchema)
    {
        if (string.IsNullOrEmpty(jsonSchema) || SupportsJsonSchemaParam(provider)) return null;
        return $"{JsonOnlySystemPrompt}\n必须严格输出符合以下 JSON Schema 的 JSON：\n```json\n{jsonSchema}\n```";
    }

    /// <summary>构造 /chat/completions 请求体（对齐 TS 的 chat / chatStream 公共部分）</summary>
    private static OpenAiChatRequest BuildBody(
        LlmConfig cfg, IReadOnlyList<ChatMessageItem> items, ChatOptionsEx opts, bool stream)
    {
        var schemaPrompt = BuildSchemaSystemPrompt(cfg.Provider, opts.JsonSchema);

        var messages = new List<OpenAiMessage>();
        if (schemaPrompt is not null) messages.Add(new OpenAiMessage("system", schemaPrompt));
        foreach (var m in items) messages.Add(new OpenAiMessage(m.Role, m.Content));

        // 流式 + 推理模型 reasoning 占用 token，给足默认值；再以 profile.maxOutput 收敛避免超过各家硬上限
        var defaultMax = stream ? 6000 : (LlmDefaults.IsLocal(cfg.Provider) ? 4000 : 2000);

        return LlmThinking.Apply(new OpenAiChatRequest
        {
            Model = cfg.Model,
            Messages = messages,
            Temperature = opts.Temperature ?? 0.3,
            MaxTokens = Math.Min(opts.MaxTokens ?? defaultMax, cfg.MaxOutput),
            Stream = stream,
            ResponseFormat = ResolveResponseFormat(cfg.Provider, opts.JsonSchema),
        }, cfg);
    }

    /// <summary>非流式（对齐 chat()）；失败返回 null</summary>
    public async Task<ChatResult?> ChatAsync(
        IReadOnlyList<ChatMessageItem> items, ChatOptionsEx? opts = null, LlmConfig? runtimeOverride = null,
        CancellationToken ct = default)
    {
        var cfg = profiles.GetConfig(runtimeOverride);
        if (cfg is null) return null;
        opts ??= new ChatOptionsEx();
        return await RawOpenAiStream.CompleteAsync(cfg, BuildBody(cfg, items, opts, stream: false), logger, ct);
    }

    /// <summary>流式（对齐 chatStream）：reasoning delta 实时回调，content delta 累加并回调，返回最终全文；失败返回 null
    /// 回调为异步——SSE 逐字推送本身是 I/O，同步回调会逼调用方 sync-over-async。</summary>
    public async Task<string?> ChatStreamAsync(
        IReadOnlyList<ChatMessageItem> items, ChatOptionsEx? opts = null,
        Func<string, Task>? onReasoning = null, Func<string, Task>? onContent = null,
        LlmConfig? runtimeOverride = null, CancellationToken ct = default)
    {
        var cfg = profiles.GetConfig(runtimeOverride);
        if (cfg is null) return null;
        opts ??= new ChatOptionsEx();
        return await RawOpenAiStream.StreamAsync(
            cfg, BuildBody(cfg, items, opts, stream: true), onReasoning, onContent, logger, ct);
    }
}
