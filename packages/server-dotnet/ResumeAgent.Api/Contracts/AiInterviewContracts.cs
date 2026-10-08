// /ai/interview 的请求 / 响应契约（字段与 packages/shared/src/ai/index.ts 的 InterviewTurnMeta 等逐一对应）

using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace ResumeAgent.Api.Contracts;

/// <summary>POST /ai/interview/sessions</summary>
public sealed record CreateInterviewSessionRequest(
    string? ResumeId = null,
    string? Title = null,
    string? TargetRole = null,
    /// <summary>用户指定的题数；缺省用面试官（模型）给出的建议</summary>
    int? QuestionCount = null);

/// <summary>POST /ai/interview/sessions/{id}/messages（Action 缺省按 answer）</summary>
public sealed record SendInterviewMessageRequest(
    string? Content = null,
    string? Action = null);

/// <summary>PATCH /ai/interview/sessions/{id}</summary>
public sealed record RenameInterviewSessionRequest(string? Title = null);

/// <summary>面试会话元信息。Focus / Jd 仅为与前端 ChatSessionMeta 结构兼容而存在（面试不用）</summary>
public sealed record InterviewSessionMeta(
    string Id,
    string ResumeId,
    string Title,
    List<string> Focus,
    string? Jd,
    string? TargetRole,
    int MessageCount,
    string LastMessageAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Preview = null);

/// <summary>
/// 面试回合元数据，写入 AiChatMessage.Meta（JSON 列）。
/// 序列化用 AppDbContext.JsonOptions（camelCase + null 也输出），与 Node 侧 JSON.stringify 的落库形态一致。
/// </summary>
public sealed record InterviewTurnMeta
{
    public string Dimension { get; init; } = "";
    public int ProbeDepth { get; init; }
    public string QuestionId { get; init; } = "";
    public string? Target { get; init; }
    public string? TargetLabel { get; init; }
    public string? Verdict { get; init; }
    public int? Score { get; init; }
    /// <summary>
    /// 判定依据，由 Quotes + Reasons 配对组成（两者等长，下标一一对应）：
    /// Quotes 是**用户原话**（逐字引用，不许改写），Reasons 说明这条原话为什么支撑判定。
    /// 分开存而不是合成一句话，是为了让用户能拿原话去核对判定，而不是只能读模型的评价。
    /// </summary>
    public List<string>? Quotes { get; init; }
    public List<string>? Reasons { get; init; }
    public string? Gap { get; init; }
    public string? Answered { get; init; }
    public bool? IsClosing { get; init; }
    public bool? IsPlan { get; init; }
    public bool? IsReport { get; init; }
    public int? QuestionCount { get; init; }
    public List<string>? Covered { get; init; }
}

/// <summary>单个维度的均分（无样本时 Score=0 / Samples=0）</summary>
public sealed record DimensionScore(int Score, int Samples, string? Weakest);

/// <summary>一道题（含其全部追问轮）的汇总</summary>
public sealed record InterviewQuestionSummary(
    string QuestionId,
    string Dimension,
    string? Target,
    string? TargetLabel,
    string Question,
    int ProbeDepth,
    string? Verdict,
    int? Score,
    /// <summary>
    /// 逐轮分数轨迹，按轮次升序。
    /// 用户要能看到「60 → 75 → 85」这样的演进，而不是只拿到一个最终数字——
    /// 分数在追问过程中是不断修正的，藏起来就看不出自己哪一轮开始慌了。
    /// </summary>
    List<InterviewRoundScore>? Rounds,
    List<string>? Quotes,
    List<string>? Reasons,
    string? Gap,
    /// <summary>用户从未作答（点「换一题」跳过）。这类题不参与均分，也不该显示成"没得分"</summary>
    bool Skipped = false);

/// <summary>某一轮追问的打分（模型偶尔会漏给 Score，此时只记 Depth）</summary>
public sealed record InterviewRoundScore(int Depth, int? Score, string? Verdict);

/// <summary>面试报告。分数一律本地聚合，不让模型自评</summary>
public sealed record InterviewReport(
    string SessionId,
    int QuestionCount,
    int AnsweredCount,
    int AvgScore,
    DimensionScore Authenticity,
    DimensionScore Depth,
    int PlanTotal,
    bool Finished,
    List<InterviewQuestionSummary> Questions);

/// <summary>GET /ai/interview/sessions/{id}</summary>
public sealed record InterviewSessionDetail(
    InterviewSessionMeta Session,
    List<ChatMessageRecord> Messages);

/// <summary>GET /ai/interview/sessions/{id}/report</summary>
public sealed record InterviewReportResponse(InterviewReport Report, string? Text);
