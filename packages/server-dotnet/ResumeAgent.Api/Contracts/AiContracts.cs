// /ai 模块的请求契约（对齐 modules/ai.ts）

using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Contracts;

public sealed record AnalyzeRequest(
    string? ResumeId = null, ResumeContent? Content = null, string? Jd = null,
    bool? Force = null, bool? Streaming = null, LlmConfig? Config = null);

/// <summary>POST /ai/config：action = add | update | remove | setActive | clear</summary>
public sealed record AiConfigRequest(
    string? Action = null, string? Id = null, string? Provider = null, string? Name = null,
    string? ApiKey = null, string? BaseUrl = null, string? Model = null,
    int? MaxContext = null, int? MaxOutput = null);

/// <summary>PATCH /ai/analyze/{resumeId}/applied</summary>
public sealed record AnalyzeAppliedRequest(string? Section = null, int? Index = null);