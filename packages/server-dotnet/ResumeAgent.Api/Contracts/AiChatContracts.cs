// /ai/chat 与 /ai/revisions 的请求 / 响应契约（字段与 packages/shared 的同名 TS 类型逐一对应）

using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace ResumeAgent.Api.Contracts;

/// <summary>POST /ai/chat/sessions</summary>
public sealed record CreateSessionRequest(
    string? ResumeId = null,
    string? Title = null,
    List<string>? Focus = null,
    string? Jd = null,
    bool? WithOpening = null);

/// <summary>PATCH /ai/chat/sessions/{id}
/// （Jd 用 JsonElement 承载：缺省时为 Undefined 表示「未传」，显式 null 表示「清空」）</summary>
public sealed record UpdateSessionRequest(
    string? Title = null,
    List<string>? Focus = null,
    JsonElement Jd = default,
    bool? Archived = null);

/// <summary>POST /ai/chat/sessions/{id}/messages</summary>
public sealed record SendMessageRequest(string? Content = null);

/// <summary>POST /ai/chat/messages/{id}/edits/{index}/applied</summary>
public sealed record MarkEditAppliedRequest(bool? Applied = null);

/// <summary>POST /ai/chat/validate-edits</summary>
public sealed record ValidateEditsRequest(
    string? ResumeId = null,
    JsonNode? Edits = null,
    string? UserText = null);

/// <summary>POST /ai/revisions</summary>
public sealed record CreateRevisionRequest(
    string? ResumeId = null,
    string? Source = null,
    string? Op = null,
    string? Section = null,
    string? Field = null,
    string? Label = null,
    string? BeforeValue = null,
    string? AfterValue = null,
    string? ItemId = null,
    string? SessionId = null,
    string? MessageId = null);

/// <summary>PATCH /ai/revisions/{id}（前端不带 body 调用，null 时按「标记已撤销」处理）</summary>
public sealed record UpdateRevisionRequest(bool? Reverted = null);

/// <summary>会话元信息（无 preview 时整个键不输出）</summary>
public sealed record SessionMeta(
    string Id,
    string ResumeId,
    string Title,
    List<string> Focus,
    string? Jd,
    int MessageCount,
    string LastMessageAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Preview);

/// <summary>一条对话消息。Meta 仅 mode=interview 会话有值（面试回合元数据）</summary>
public sealed record ChatMessageRecord(
    string Id,
    string SessionId,
    string Role,
    string Content,
    JsonNode? Edits,
    List<int> AppliedIndexes,
    string? Reasoning,
    string CreatedAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] JsonNode? Meta = null);

/// <summary>一笔修订账本记录</summary>
public sealed record RevisionRecord(
    string Id,
    string ResumeId,
    string UserId,
    string Source,
    string Op,
    string Section,
    string Field,
    string Label,
    string? BeforeValue,
    string? AfterValue,
    string? ItemId,
    string? SessionId,
    string? MessageId,
    string? RevertedAt,
    string CreatedAt);

/// <summary>体检待办，同时作为响应体（无 field 时整个键不输出）</summary>
public sealed record AuditTask(
    string Id,
    string Kind,
    string Severity,
    string Title,
    string Prompt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Field = null);