// 硬规则检查（纯本地，零成本）：对齐 modules/ai.ts 的 ruleChecks / ruleAtsScore

using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Services.Analysis;

public static class RuleChecks
{
    public static ResumeAnalysis.AnalysisSections Check(ResumeContent content)
    {
        var basic = new List<Issue>();
        var works = new List<Issue>();
        var projects = new List<Issue>();
        var skills = new List<Issue>();

        // --- 基础信息 ---
        if (string.IsNullOrWhiteSpace(content.Basic.Name))
            basic.Add(new Issue { Severity = "error", Field = "basic.name", Problem = "未填写姓名", Suggestion = "请填写真实姓名" });
        if (string.IsNullOrWhiteSpace(content.Basic.Phone) && string.IsNullOrWhiteSpace(content.Basic.Email))
            basic.Add(new Issue { Severity = "error", Field = "basic.phone", Problem = "电话和邮箱都未填写", Suggestion = "至少提供一种联系方式" });
        if (string.IsNullOrWhiteSpace(content.Basic.Title))
            basic.Add(new Issue { Severity = "warning", Field = "basic.title", Problem = "未填写求职意向", Suggestion = "明确的求职意向能帮 HR 快速判断匹配度" });

        // --- 工作经历 ---
        if (content.Works.Count == 0 && content.Projects.Count == 0)
            works.Add(new Issue { Severity = "warning", Field = "works", Problem = "既无工作经历也无项目经历", Suggestion = "至少补充一段经历来展示能力" });
        for (var i = 0; i < content.Works.Count; i++)
        {
            var w = content.Works[i];
            var prefix = $"works[{i}]";
            var n = i + 1;
            if (string.IsNullOrWhiteSpace(w.Company)) works.Add(new Issue { Severity = "error", Field = $"{prefix}.company", Problem = $"第 {n} 段工作未填写公司" });
            if (string.IsNullOrWhiteSpace(w.Role)) works.Add(new Issue { Severity = "error", Field = $"{prefix}.role", Problem = $"第 {n} 段工作未填写职位" });
            if (string.IsNullOrEmpty(w.Start)) works.Add(new Issue { Severity = "error", Field = $"{prefix}.start", Problem = $"第 {n} 段工作未填开始时间" });
            if (!w.Current && string.IsNullOrEmpty(w.End)) works.Add(new Issue { Severity = "error", Field = $"{prefix}.end", Problem = $"第 {n} 段工作未填结束时间" });
            if (!string.IsNullOrEmpty(w.Start) && !string.IsNullOrEmpty(w.End) && string.CompareOrdinal(w.Start, w.End) > 0)
                works.Add(new Issue { Severity = "error", Field = $"{prefix}.start", Problem = $"第 {n} 段工作起止时间颠倒" });
            if (w.Description.Length > 0 && w.Description.Length < 20)
                works.Add(new Issue { Severity = "warning", Field = $"{prefix}.description", Problem = $"第 {n} 段工作描述过短", Suggestion = "建议用 3-5 条成果来描述，包含量化数据" });
        }

        // --- 项目经历 ---
        for (var i = 0; i < content.Projects.Count; i++)
        {
            var p = content.Projects[i];
            var prefix = $"projects[{i}]";
            var n = i + 1;
            if (string.IsNullOrWhiteSpace(p.Name)) projects.Add(new Issue { Severity = "error", Field = $"{prefix}.name", Problem = $"第 {n} 个项目未填写名称" });
            if (p.Description.Length > 0 && p.Description.Length < 20)
                projects.Add(new Issue { Severity = "warning", Field = $"{prefix}.description", Problem = $"第 {n} 个项目描述过短", Suggestion = "建议说明技术栈、你的角色和量化成果" });
        }

        // --- 技能 ---
        if (content.Skills.Count == 0)
            skills.Add(new Issue { Severity = "warning", Field = "skills", Problem = "未填写任何技能", Suggestion = "按分类列出你的技术栈" });

        return new ResumeAnalysis.AnalysisSections { Basic = basic, Works = works, Projects = projects, Skills = skills };
    }

    /// <summary>硬规则算一个基础 ATS 分（仅完整性维度）</summary>
    public static int RuleAtsScore(ResumeContent content)
    {
        var score = 60;
        var b = content.Basic;
        if (!string.IsNullOrEmpty(b.Name)) score += 5;
        if (!string.IsNullOrEmpty(b.Phone) || !string.IsNullOrEmpty(b.Email)) score += 5;
        if (!string.IsNullOrEmpty(b.Title)) score += 5;
        if (b.Summary.Length > 50) score += 5;
        if (content.Works.Count >= 1) score += 5;
        if (content.Works.Count >= 3) score += 5;
        if (content.Projects.Count >= 1) score += 5;
        if (content.Skills.Count >= 2) score += 5;
        return Math.Min(100, score);
    }
}
