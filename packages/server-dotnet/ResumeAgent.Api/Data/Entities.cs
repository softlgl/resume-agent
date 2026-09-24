// 实体定义：与 packages/server/prisma/schema.prisma 的 4 个 model 一一对应

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
    public DateTime CreatedAt { get; set; }
}

public class LlmCallLog
{
    public string Id { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Kind { get; set; } = "analyze";  // analyze | import
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
