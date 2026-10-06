// 实体定义：与 packages/server/prisma/schema.prisma 的 7 个 model 一一对应

using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Data;

public class User
{
    public string Id { get; set; } = "";
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}

public class AiModelProfile
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Provider { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public string BaseUrl { get; set; } = "";
    public string Model { get; set; } = "";
    public int MaxContext { get; set; } = 32768;  // 输入上下文上限（token）
    public int MaxOutput { get; set; } = 4096;    // 输出上限（token）
    public bool Active { get; set; }              // 全局同时只有一个激活
    public string ThinkingMode { get; set; } = "follow"; // 思考开关：follow(跟随模型默认) | on | off
    public DateTime CreatedAt { get; set; }
}

public class LlmCallLog
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Kind { get; set; } = "analyze";  // analyze | import | chat
    public string? ResumeId { get; set; }          // 分析按简历归属；导入为 null
    public string Provider { get; set; } = "";
    public string Model { get; set; } = "";
    public bool Ok { get; set; } = true;
    public string? Reasoning { get; set; }         // 模型思考过程原文
    public string? Output { get; set; }            // 模型返回原始 JSON
    public DateTime CreatedAt { get; set; }
}

public class Resume
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Title { get; set; } = "我的简历";
    public string TemplateId { get; set; } = "classic";
    public ResumeContent Content { get; set; } = new();  // ResumeContent（JSON 列，强类型）
    public string? AnalysisJson { get; set; }            // AI 分析结果缓存（JSON 列，schema-free 原文）
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>AI 对话会话（同一简历可开多个会话）</summary>
public class AiChatSession
{
    public string Id { get; set; } = "";
    public string ResumeId { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Title { get; set; } = "新对话";
    public string? Focus { get; set; }         // JSON 字符串：焦点字段路径数组
    public string? Jd { get; set; }            // 本会话的 JD 定向文本
    public bool Archived { get; set; }
    public DateTime LastMessageAt { get; set; }
    public DateTime CreatedAt { get; set; }
}

/// <summary>对话消息（edits 为服务端已校验的规范化修改建议）</summary>
public class AiChatMessage
{
    public string Id { get; set; } = "";
    public string SessionId { get; set; } = "";
    public string Role { get; set; } = "";         // user | assistant
    public string Content { get; set; } = "";
    public string? Edits { get; set; }             // JSON 列：ResumeEdit[]，仅 assistant 消息有
    public string? AppliedIndexes { get; set; }    // JSON 列：number[]：已应用的 edit 下标
    public string? Reasoning { get; set; }
    public DateTime CreatedAt { get; set; }
}

/// <summary>统一修订账本（append-only；撤销只写 RevertedAt）；对话侧与分析侧共用，是简历内容回滚的唯一依据</summary>
public class AiRevision
{
    public string Id { get; set; } = "";
    public string ResumeId { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Source { get; set; } = "";       // chat | analysis
    public string Op { get; set; } = "";           // set | append
    public string Section { get; set; } = "";
    public string Field { get; set; } = "";
    public string Label { get; set; } = "";
    public string? BeforeValue { get; set; }
    public string? AfterValue { get; set; }
    public string? ItemId { get; set; }            // append：写入条目的 id
    public string? SessionId { get; set; }
    public string? MessageId { get; set; }
    public DateTime? RevertedAt { get; set; }
    public DateTime CreatedAt { get; set; }
}
