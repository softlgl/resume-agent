// M.E.AI 聊天服务（对齐 llm.ts 的 chat / chatStream）：
// - IChatClient 抽象：OpenAI 兼容端点（openai/deepseek/doubao/qwen/vllm/lmstudio/ollama）统一走 OpenAI 连接器
// - provider 策略：openai 用 json_schema；deepseek/doubao/qwen 用 json_object；本地模型注入行内 JSON 提示
// - 流式：TextReasoningContent → onReasoning（思考过程逐字），TextContent → onContent + 返回全文
// - maxOutput clamp：调用方给的再大也被收敛到 profile.maxOutput

using System.ClientModel;
using System.Text.Json;
using Microsoft.Extensions.AI;
using OpenAI;

namespace ResumeAgent.Api.Services.Llm;

public class ChatMessageItem(string role, string content)
{
    public string Role { get; set; } = role;
    public string Content { get; set; } = content;
}

public class ChatOptionsEx
{
    public double? Temperature { get; set; }
    public int? MaxTokens { get; set; }
    public string? JsonSchema { get; set; } // 期望的结构化输出 JSON Schema（可选）
}

public class ChatResult
{
    public string Text { get; set; } = "";
    public int? PromptTokens { get; set; }
    public int? CompletionTokens { get; set; }
}

public class ChatService(ProfileSnapshotService profiles, ILogger<ChatService> logger)
{
    private const string JsonOnlySystemPrompt = "你必须严格输出 JSON，不要加任何其他文字、解释或 markdown 代码块。";

    /// <summary>按 provider 构建 IChatClient（OpenAI 兼容协议统一走 OpenAI 连接器）</summary>
    public IChatClient BuildClient(LlmConfig cfg)
    {
        var options = new OpenAIClientOptions { Endpoint = new Uri(cfg.BaseUrl.TrimEnd('/')) };
        var openAi = new OpenAIClient(new ApiKeyCredential(cfg.ApiKey), options);
        return openAi.GetChatClient(cfg.Model).AsIChatClient();
    }

    /// <summary>provider 策略：决定 ResponseFormat / 是否注入 JSON-only system 消息</summary>
    private (ChatResponseFormat? Format, bool PrependJsonOnly) ResolveFormat(LlmProvider provider, string? jsonSchema)
    {
        if (string.IsNullOrEmpty(jsonSchema)) return (null, false);
        if (LlmDefaults.IsLocal(provider)) return (null, true);
        if (provider == LlmProvider.Openai)
        {
            var schema = JsonDocument.Parse(jsonSchema).RootElement.Clone();
            return (ChatResponseFormat.ForJsonSchema(schema), false);
        }
        return (ChatResponseFormat.Json, false); // deepseek/doubao/qwen：json_object（json_schema 会 400）
    }

    private List<ChatMessage> BuildMessages(IReadOnlyList<ChatMessageItem> items, bool prependJsonOnly)
    {
        var messages = new List<ChatMessage>();
        if (prependJsonOnly)
            messages.Add(new ChatMessage(ChatRole.System, JsonOnlySystemPrompt));
        foreach (var m in items)
            messages.Add(new ChatMessage(
                m.Role switch
                {
                    "system" => ChatRole.System,
                    "assistant" => ChatRole.Assistant,
                    _ => ChatRole.User,
                }, m.Content));
        return messages;
    }

    private ChatOptions BuildChatOptions(LlmConfig cfg, ChatOptionsEx opts, ChatResponseFormat? format)
    {
        // 流式 + 推理模型 reasoning 占用 token，给足默认值；再以 profile.maxOutput 收敛避免超过各家硬上限
        var isLocal = LlmDefaults.IsLocal(cfg.Provider);
        var defaultMax = isLocal ? 4000 : 2000;
        return new ChatOptions
        {
            Temperature = (float)(opts.Temperature ?? 0.3),
            MaxOutputTokens = Math.Min(opts.MaxTokens ?? defaultMax, cfg.MaxOutput),
            ResponseFormat = format,
        };
    }

    /// <summary>非流式（对齐 chat()）；失败返回 null</summary>
    public async Task<ChatResult?> ChatAsync(
        IReadOnlyList<ChatMessageItem> items, ChatOptionsEx? opts = null, LlmConfig? runtimeOverride = null,
        CancellationToken ct = default)
    {
        var cfg = profiles.GetConfig(runtimeOverride);
        if (cfg is null) return null;
        opts ??= new ChatOptionsEx();
        var (format, prepend) = ResolveFormat(cfg.Provider, opts.JsonSchema);

        try
        {
            var client = BuildClient(cfg);
            var response = await client.GetResponseAsync(BuildMessages(items, prepend), BuildChatOptions(cfg, opts, format), ct);
            var text = response.Text ?? "";
            return new ChatResult
            {
                Text = CleanFences(text),
                PromptTokens = (int?)response.Usage?.InputTokenCount,
                CompletionTokens = (int?)response.Usage?.OutputTokenCount,
            };
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "[LLM] {Provider} 请求失败", cfg.Provider);
            return null;
        }
    }

    /// <summary>流式（对齐 chatStream）：reasoning delta 实时回调，content delta 累加并回调，返回最终全文；失败返回 null</summary>
    public async Task<string?> ChatStreamAsync(
        IReadOnlyList<ChatMessageItem> items, ChatOptionsEx? opts = null,
        Action<string>? onReasoning = null, Action<string>? onContent = null,
        LlmConfig? runtimeOverride = null, CancellationToken ct = default)
    {
        var cfg = profiles.GetConfig(runtimeOverride);
        if (cfg is null) return null;
        opts ??= new ChatOptionsEx();
        var (format, prepend) = ResolveFormat(cfg.Provider, opts.JsonSchema);

        // 非 OpenAI 官方协议的 provider 走原始 SSE 兼容层：
        // OpenAI .NET SDK 会丢弃第三方端点 delta 里的 reasoning_content（思考过程），导致推理流为空
        if (cfg.Provider != LlmProvider.Openai)
        {
            IReadOnlyList<ChatMessageItem> rawItems = prepend
                ? new[] { new ChatMessageItem("system", JsonOnlySystemPrompt) }.Concat(items).ToList()
                : items;
            return await RawOpenAiStream.StreamAsync(
                cfg, rawItems, opts,
                useJsonObjectFormat: !string.IsNullOrEmpty(opts.JsonSchema) && !LlmDefaults.IsLocal(cfg.Provider),
                onReasoning, onContent, logger, ct);
        }

        // 流式 + 推理模型 reasoning 占用 token，给足 maxTokens 避免 JSON 被截断（对齐 TS 的 6000 默认值）
        var chatOpts = BuildChatOptions(cfg, opts, format);
        if (opts.MaxTokens is null) chatOpts.MaxOutputTokens = Math.Min(6000, cfg.MaxOutput);

        var accum = new System.Text.StringBuilder();
        try
        {
            var client = BuildClient(cfg);
            await foreach (var update in client.GetStreamingResponseAsync(BuildMessages(items, prepend), chatOpts, ct))
            {
                foreach (var part in update.Contents)
                {
                    switch (part)
                    {
                        case TextReasoningContent rc when !string.IsNullOrEmpty(rc.Text):
                            onReasoning?.Invoke(rc.Text);
                            break;
                        case TextContent tc when !string.IsNullOrEmpty(tc.Text):
                            accum.Append(tc.Text);
                            onContent?.Invoke(tc.Text);
                            break;
                        case UsageContent:
                            break;
                    }
                }
                // 兜底：DeepSeek 等非标准字段可能挂在 AdditionalProperties（reasoning_content / reasoning）
                if (update.AdditionalProperties is not null)
                    foreach (var key in new[] { "reasoning_content", "reasoning" })
                        if (update.AdditionalProperties.TryGetValue(key, out var v) && v is string s && s.Length > 0)
                            onReasoning?.Invoke(s);
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            logger.LogError(ex, "[LLM] {Provider} 流式请求失败", cfg.Provider);
            return null;
        }
        return accum.ToString().Trim();
    }

    /// <summary>对齐 TS 的 ``` 围栏清理：模型偶发输出 markdown 代码块包裹的 JSON</summary>
    private static string CleanFences(string text)
    {
        var t = text.Trim();
        if (t.StartsWith("```"))
        {
            var firstNl = t.IndexOf('\n');
            if (firstNl > 0) t = t[(firstNl + 1)..];
            if (t.EndsWith("```")) t = t[..^3];
        }
        return t.Trim();
    }
}
