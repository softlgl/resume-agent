// AI 分析结果模型（对齐 modules/ai.ts 的类型定义，前后端共用 JSON 形状）

using System.Text.Json.Serialization;

namespace ResumeAgent.Api.Services.Analysis;

public enum IssueSeverity { Error, Warning, Tip }

public class Issue
{
    [JsonPropertyName("severity")] public string Severity { get; set; } = "warning"; // error | warning | tip
    [JsonPropertyName("field")] public string Field { get; set; } = "";   // 如 "works[0].summary"，前端据此定位
    [JsonPropertyName("problem")] public string Problem { get; set; } = "";
    [JsonPropertyName("suggestion")] public string? Suggestion { get; set; }
    [JsonPropertyName("rewrite")] public string? Rewrite { get; set; }    // AI 改写后的完整内容
    [JsonPropertyName("applied")] public bool Applied { get; set; }       // 改写是否已被用户应用
}

public class AbilityProfile
{
    public int Tech { get; set; } = 50;
    public int Project { get; set; } = 50;
    public int Stability { get; set; } = 50;
    public int Communication { get; set; } = 50;
    public int Education { get; set; } = 50;
}

public class AnalysisSummary
{
    public string Overall { get; set; } = "";
    public List<string> Strengths { get; set; } = [];
    public List<string> Weaknesses { get; set; } = [];
    public string Priority { get; set; } = "";
}

public class MustHave
{
    public string Skill { get; set; } = "";
    public bool Matched { get; set; }
}

public class MatchResult
{
    public int Score { get; set; }
    public List<MustHave> MustHaves { get; set; } = [];
    public List<string> Gaps { get; set; } = [];
}

public class ResumeAnalysis
{
    public int AtsScore { get; set; }
    public int? QualityScore { get; set; }
    public AnalysisSections Sections { get; set; } = new();
    public AnalysisSummary? Summary { get; set; }
    public AbilityProfile? AbilityProfile { get; set; }
    public MatchResult? Match { get; set; }
    public bool LlmUsed { get; set; }
    public string? LlmProvider { get; set; }
    public string? Reasoning { get; set; }
    public string? Output { get; set; }

    public class AnalysisSections
    {
        public List<Issue> Basic { get; set; } = [];
        public List<Issue> Works { get; set; } = [];
        public List<Issue> Projects { get; set; } = [];
        public List<Issue> Skills { get; set; } = [];
    }
}
