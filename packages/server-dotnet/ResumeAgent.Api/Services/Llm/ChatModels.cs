// ChatService 的入参 / 出参模型（对齐 llm.ts 的 ChatMessage / ChatOptions）

using System.Text.Json.Serialization;

namespace ResumeAgent.Api.Services.Llm;

public sealed class ChatMessageItem(string role, string content)
{
    public string Role { get; set; } = role;
    public string Content { get; set; } = content;
}

public sealed class ChatOptionsEx
{
    public double? Temperature { get; set; }
    public int? MaxTokens { get; set; }
    public string? JsonSchema { get; set; } // 期望的结构化输出 JSON Schema（可选）
}

public sealed class ChatResult
{
    public string Text { get; set; } = "";
    public int? PromptTokens { get; set; }
    public int? CompletionTokens { get; set; }
}

// ---------------------------------------------------------------------------
// OpenAI 兼容 /chat/completions 线协议模型（请求体与流式分片）
// 键名一律用 [JsonPropertyName] 显式固定：协议要求 snake_case，不能依赖全局命名策略。
// ---------------------------------------------------------------------------

public sealed record OpenAiChatRequest
{
    [JsonPropertyName("model")] public required string Model { get; init; }
    [JsonPropertyName("messages")] public required IReadOnlyList<OpenAiMessage> Messages { get; init; }
    [JsonPropertyName("temperature")] public required double Temperature { get; init; }
    [JsonPropertyName("max_tokens")] public required int MaxTokens { get; init; }
    [JsonPropertyName("stream")] public required bool Stream { get; init; }
    [JsonPropertyName("response_format")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public OpenAiResponseFormat? ResponseFormat { get; init; }
}

public sealed record OpenAiMessage(
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("content")] string Content);

public sealed record OpenAiResponseFormat([property: JsonPropertyName("type")] string Type);

/// <summary>流式分片：只声明关心的字段，未知字段由序列化器忽略</summary>
public sealed record OpenAiStreamChunk(
    [property: JsonPropertyName("choices")] List<OpenAiChoice>? Choices);

public sealed record OpenAiChoice(
    [property: JsonPropertyName("delta")] OpenAiDelta? Delta);

/// <summary>思考过程字段名各家不一：reasoning_content（dashscope/deepseek）或 reasoning（兜底）</summary>
public sealed record OpenAiDelta(
    [property: JsonPropertyName("content")] string? Content,
    [property: JsonPropertyName("reasoning_content")] string? ReasoningContent,
    [property: JsonPropertyName("reasoning")] string? Reasoning);