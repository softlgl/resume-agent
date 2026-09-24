// LLM 分析 + 归一化 + 防编造过滤（对齐 modules/ai.ts 的 llmAnalyze / mergeIssues / analyze / jdMatch）

using System.Text.Json;
using System.Text.Json.Nodes;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Services.Analysis;

public class Analyzer(ChatService chat, ProfileSnapshotService profiles, ILogger<Analyzer> logger)
{
    public record AnalyzeCallbacks(Action<string>? OnReasoning = null, Action<string>? OnContent = null);

    // ---------------------------------------------------------------------
    // LLM 分析
    // ---------------------------------------------------------------------

    public async Task<ResumeAnalysis?> LlmAnalyzeAsync(
        ResumeContent content, string? jd, AnalyzeCallbacks? cb = null, LlmConfig? runtimeOverride = null, CancellationToken ct = default)
    {
        if (!profiles.IsAvailable(runtimeOverride)) return null;

        var reasoningTxt = "";
        var node = JsonNode.Parse(JsonSerializer.Serialize(content));
        if (node is null) return null;
        var sanitized = Prompts.SanitizeContent(node);

        var messages = new List<ChatMessageItem>
        {
            new("system", Prompts.BuildSystemPrompt()),
            new("user", Prompts.BuildUserPrompt(sanitized, jd)),
        };
        var opts = new ChatOptionsEx
        {
            JsonSchema = Prompts.AnalysisSchema,
            Temperature = 0.3,
            // 思考与正文共享预算；给足够大的上限，让真实卡点收敛到 profile.maxOutput
            MaxTokens = 262144,
        };
        var text = await chat.ChatStreamAsync(messages, opts,
            d => { reasoningTxt += d; cb?.OnReasoning?.Invoke(d); },
            cb?.OnContent, runtimeOverride, ct);
        if (string.IsNullOrEmpty(text)) return null;

        var parsed = JsonNode.Parse(text) as JsonObject;
        if (parsed is null) return null;

        // 归一化：本地模型可能返回不同的字段名（technicalAbility vs tech）
        var norm = parsed["abilityProfile"] as JsonObject ?? [];
        var ap = new AbilityProfile
        {
            Tech = FirstInt(norm, 50, "tech", "technicalAbility", "technical_ability"),
            Project = FirstInt(norm, 50, "project", "projectComplexity", "project_complexity"),
            Stability = FirstInt(norm, 50, "stability", "workStability", "work_stability"),
            Communication = FirstInt(norm, 50, "communication", "communicationAbility", "communication_ability"),
            Education = FirstInt(norm, 50, "education", "educationBackground", "education_background"),
        };

        var sections = NormalizeSections(parsed);

        // 硬过滤：AI 不可能编造真实值的字段（时间、链接、联系方式、薪资等），
        // 即使 LLM 输出了 rewrite 也强行清空，防止瞎编误导前端"应用"按钮
        var noRewrite = new System.Text.RegularExpressions.Regex(
            @"\.(start|end|link|url|github|gitee|phone|mobile|tel|email|mail|qq|wechat|wx|address|location|salary|expect|expectedSalary|birthday|birth|age|gender|avatar|photo|image|portfolio|blog|website|homepage|doubao|zhihu|bilibili|juejin|csdn|leetcode|hotjob|jobPosition|jobLevel)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var suggestionPatterns = new[] { "^建议", "^可以", "^推荐", "^应该", "^最好", "需补充", "需添加", "请填写", "请补充" };
        foreach (var list in new[] { sections.Basic, sections.Works, sections.Projects, sections.Skills })
        {
            foreach (var it in list)
            {
                if (it.Rewrite is null) continue;
                if (noRewrite.IsMatch(it.Field)) { it.Rewrite = null; continue; }
                // 整段容器字段（field 不含下标 [ 或 .）：rewrite 会把容器覆写成字符串导致前端崩溃
                if (!it.Field.Contains('[') && !it.Field.Contains('.')) { it.Rewrite = null; continue; }
                // 明显是建议式文字（如"建议添加..."）也清空
                if (suggestionPatterns.Any(p =>
                        System.Text.RegularExpressions.Regex.IsMatch(it.Rewrite!.Trim(), p)))
                {
                    it.Rewrite = null;
                }
            }
        }

        // 结构化总结：对模型可能使用的不同字段名做兜底
        AnalysisSummary? summary = null;
        var sRaw = (parsed["summary"] ?? parsed["overview"] ?? parsed["conclusion"]) as JsonObject;
        if (sRaw is not null)
        {
            summary = new AnalysisSummary
            {
                Overall = FirstStr(sRaw, "overall", "overview", "summary") ?? "",
                Strengths = StrList(sRaw["strengths"]),
                Weaknesses = StrList(sRaw["weaknesses"]),
                Priority = FirstStr(sRaw, "priority", "action", "recommendation") ?? "",
            };
        }

        return new ResumeAnalysis
        {
            AtsScore = parsed["atsScore"] is JsonValue av && av.TryGetValue<int>(out var ats) ? ats : 0,
            QualityScore = parsed["qualityScore"] is JsonValue qv && qv.TryGetValue<int>(out var q) ? q : null,
            Sections = sections,
            Summary = summary,
            AbilityProfile = ap,
            Reasoning = reasoningTxt,
            Output = text,
        };
    }

    // 归一化 sections：模型可能返回三种格式
    // 格式1（扁平数组）: [{ path: "works[0].desc", issue: "...", severity: "error" }]
    // 格式2（分组对象）: { basic: [...], works: [...] }
    // 格式3（两级嵌套）: [{ section: "works", issues: [{ description: "...", severity: "warning" }] }]
    private static ResumeAnalysis.AnalysisSections NormalizeSections(JsonObject parsed)
    {
        var sections = new ResumeAnalysis.AnalysisSections();
        var raw = parsed["sections"] ?? parsed["issues"] ?? parsed["problems"];
        if (raw is JsonArray flat)
        {
            var first = flat.Count > 0 ? flat[0] as JsonObject : null;
            if (first is not null && first["issues"] is JsonArray)
            {
                // 格式3: [{ section: "basic", issues: [...] }]
                // 分组名统一小写比较：模型常返回 "Works"/"Projects"/"Skills"（PascalCase），
                // 严格相等会全部落进 basic 兜底桶，导致对应分区的改写建议"消失"
                foreach (var group in flat.OfType<JsonObject>())
                {
                    // 分组名候选键：section / name / sectionName / section_name（模型输出键名多变）
                    var section = (FirstStr(group, "section", "name", "sectionName", "section_name") ?? "").ToLowerInvariant();
                    var bucket =
                        section == "works" || section == "工作经历" ? sections.Works :
                        section == "projects" || section == "项目经历" ? sections.Projects :
                        section == "skills" || section == "技能" ? sections.Skills :
                        sections.Basic;
                    foreach (var it in (group["issues"] as JsonArray ?? []).OfType<JsonObject>())
                        bucket.Add(MakeIssue(it, section));
                }
            }
            else
            {
                // 格式1: 扁平数组
                foreach (var item in flat.OfType<JsonObject>())
                {
                    var field = (FirstStr(item, "path", "section", "field", "key") ?? "").ToLowerInvariant();
                    var issue = MakeIssue(item);
                    if (field.StartsWith("basic") || field.StartsWith("基本")) sections.Basic.Add(issue);
                    else if (field.StartsWith("works") || field.StartsWith("工作")) sections.Works.Add(issue);
                    else if (field.StartsWith("projects") || field.StartsWith("项目")) sections.Projects.Add(issue);
                    else if (field.StartsWith("skills") || field.StartsWith("技能")) sections.Skills.Add(issue);
                    else sections.Basic.Add(issue);
                }
            }
        }
        else if (raw is JsonObject grouped)
        {
            // 格式2: 分组对象
            sections.Basic = Arr(grouped, "basic", "基本信息", "basicInfo").OfType<JsonObject>().Select(i => MakeIssue(i, "basic")).ToList();
            sections.Works = Arr(grouped, "works", "工作经历", "workExp").OfType<JsonObject>().Select(i => MakeIssue(i, "works")).ToList();
            sections.Projects = Arr(grouped, "projects", "项目经历").OfType<JsonObject>().Select(i => MakeIssue(i, "projects")).ToList();
            sections.Skills = Arr(grouped, "skills", "技能").OfType<JsonObject>().Select(i => MakeIssue(i, "skills")).ToList();
        }
        return sections;

        static JsonArray Arr(JsonObject o, params string[] keys)
        {
            foreach (var k in keys)
                if (o[k] is JsonArray a) return a;
            return [];
        }
    }

    private static Issue MakeIssue(JsonObject item, string defaultField = "")
    {
        // field 统一归一化为小写：前端按简历 JSON 的 camelCase 键定位字段
        // （basic.summary / works[0].description），模型常返回 "Works[0].Description"，
        // 大小写不一致会导致"应用改写"定位失败
        // 注意键优先级：field/path 是真实字段路径；section 是分区名（格式 1 变体里两者并存），
        // 若 section 优先会把 "Works" 当字段路径，进而触发整段过滤把 rewrite 清掉
        var field = (FirstStr(item, "path", "field", "key", "section") ?? defaultField).ToLowerInvariant();
        var problem = FirstStr(item, "problem", "issue", "description", "message") ?? "";
        var suggestion = FirstStr(item, "suggestion", "fix");
        // 关键：提取 AI 修正后的完整内容（兼容不同模型可能用的字段名）
        var rewrite = FirstStr(item, "rewrite", "rewritten", "fixed", "edited", "newContent", "revised");
        var level = FirstStr(item, "severity", "level") ?? "warning";
        var severity = level switch
        {
            "error" or "严重" => "error",
            "tip" or "建议" or "info" => "tip",
            _ => "warning",
        };
        return new Issue { Severity = severity, Field = field, Problem = problem, Suggestion = suggestion, Rewrite = rewrite };
    }

    // ---------------------------------------------------------------------
    // 合并硬规则 + LLM 结果
    // ---------------------------------------------------------------------

    private static List<Issue> MergeIssues(List<Issue> a, List<Issue> b)
    {
        // 简单合并：硬规则问题在前，LLM 建议在后；同一 field 不重复
        var seen = new HashSet<string>();
        var merged = new List<Issue>();
        foreach (var it in a.Concat(b))
        {
            var key = $"{it.Field}|{it.Problem}";
            if (seen.Add(key)) merged.Add(it);
        }
        return merged;
    }

    public async Task<ResumeAnalysis> AnalyzeAsync(
        ResumeContent content, string? jd, AnalyzeCallbacks? cb = null, LlmConfig? runtimeOverride = null, CancellationToken ct = default)
    {
        var rule = RuleChecks.Check(content);
        var ruleAts = RuleChecks.RuleAtsScore(content);

        var llm = await LlmAnalyzeAsync(content, jd, cb, runtimeOverride, ct);

        var sections = new ResumeAnalysis.AnalysisSections
        {
            Basic = MergeIssues(rule.Basic, llm?.Sections.Basic ?? []),
            Works = MergeIssues(rule.Works, llm?.Sections.Works ?? []),
            Projects = MergeIssues(rule.Projects, llm?.Sections.Projects ?? []),
            Skills = MergeIssues(rule.Skills, llm?.Sections.Skills ?? []),
        };

        var providerName = profiles.GetConfig(runtimeOverride) is { } c ? LlmDefaults.ProviderName(c.Provider) : null;
        return new ResumeAnalysis
        {
            AtsScore = llm?.AtsScore > 0 ? llm.AtsScore : ruleAts,
            QualityScore = llm?.QualityScore,
            Sections = sections,
            Summary = llm?.Summary,
            AbilityProfile = llm?.AbilityProfile,
            LlmUsed = llm is not null,
            LlmProvider = llm is not null ? providerName : null,
            Reasoning = llm?.Reasoning,
            Output = llm?.Output,
        };
    }

    /// <summary>JD 匹配（可选，单独端点，和基础分析解耦）</summary>
    public async Task<MatchResult?> JdMatchAsync(ResumeContent content, string jd, LlmConfig? runtimeOverride = null, CancellationToken ct = default)
    {
        if (!profiles.IsAvailable(runtimeOverride)) return null;
        var node = JsonNode.Parse(JsonSerializer.Serialize(content));
        if (node is null) return null;
        var sanitized = Prompts.SanitizeContent(node);
        var result = await chat.ChatAsync(
        [
            new("system", "你是招聘专家。请对比候选人简历和目标岗位 JD，判断匹配度。先从 JD 提取 5-10 个硬性要求（技能/经验/学历），逐条判断简历是否满足，然后列出明确的差距项。"),
            new("user", $"简历：\n```json\n{sanitized.ToJsonString()}\n```\n\nJD：\n{jd}"),
        ], new ChatOptionsEx { JsonSchema = Prompts.MatchSchema, Temperature = 0.2 }, runtimeOverride, ct);
        if (string.IsNullOrEmpty(result?.Text)) return null;
        try
        {
            return JsonSerializer.Deserialize<MatchResult>(result.Text, AppJson.Options);
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "[AI] JD 匹配结果解析失败");
            return null;
        }
    }

    // ---------------------------------------------------------------------
    // JsonNode 小工具
    // ---------------------------------------------------------------------

    private static int FirstInt(JsonObject o, int dflt, params string[] keys)
    {
        foreach (var k in keys)
            if (o[k] is JsonValue v && v.TryGetValue<int>(out var i)) return i;
        return dflt;
    }

    private static string? FirstStr(JsonObject o, params string[] keys)
    {
        foreach (var k in keys)
            if (o[k] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0) return s;
        return null;
    }

    private static List<string> StrList(JsonNode? node)
    {
        if (node is not JsonArray arr) return [];
        var list = new List<string>();
        foreach (var item in arr)
            if (item is JsonValue v && v.TryGetValue<string>(out var s)) list.Add(s);
        return list;
    }
}

/// <summary>Analysis 域专用 JSON 反序列化选项（camelCase，与前端契约一致）</summary>
public static class AppJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };
}
