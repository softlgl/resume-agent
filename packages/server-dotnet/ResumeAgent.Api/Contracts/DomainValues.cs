// 跨模块共享的字符串取值（对应 Node 版 TS 里的字符串字面量联合类型）。
// 刻意用 const string 而非 enum：这些值会原样进入响应 JSON 与数据库行，
// 枚举序列化会改变取值（比如 provider 被写成数字），必须与 Node 版逐字一致。

namespace ResumeAgent.Api.Contracts;

/// <summary>ResumeEdit.Op / AiRevision.Op：改写现有字段 或 新增条目</summary>
public static class EditOp
{
    public const string Set = "set";
    public const string Append = "append";
}

/// <summary>LlmCallLog.Kind：区分这次 LLM 调用来自哪条链路</summary>
public static class LlmCallKind
{
    public const string Analyze = "analyze";
    public const string Chat = "chat";
    public const string Import = "import";
}

/// <summary>AiRevision.Source：修订来自对话侧还是分析侧</summary>
public static class RevisionSource
{
    public const string Chat = "chat";
    public const string Analysis = "analysis";
}

/// <summary>消息角色（AiChatMessage.Role 与发给 LLM 的消息）</summary>
public static class ChatMessageRole
{
    public const string System = "system";
    public const string User = "user";
    public const string Assistant = "assistant";
}

/// <summary>Issue.Severity</summary>
public static class IssueSeverity
{
    public const string Error = "error";
    public const string Warning = "warning";
    public const string Tip = "tip";
}

/// <summary>简历分区名（与前端契约一致；含中文别名的地方各自保留原样）</summary>
public static class ResumeSection
{
    public const string Basic = "basic";
    public const string Works = "works";
    public const string Educations = "educations";
    public const string Projects = "projects";
    public const string Skills = "skills";
}

/// <summary>JSON 列的固定字面量</summary>
public static class JsonLiteral
{
    /// <summary>AiChatMessage.AppliedIndexes 的初始值（空下标数组）</summary>
    public const string EmptyArray = "[]";
}