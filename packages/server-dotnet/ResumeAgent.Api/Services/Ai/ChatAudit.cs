// 体检待办与开场消息：纯本地拼装，不调 LLM。
// 供「新建会话（带开场消息）」与「会话详情」共用。

using System.Text.Json;
using System.Text.Json.Nodes;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Services.Edit;

namespace ResumeAgent.Api.Services.Ai;

internal static class ChatAudit
{
    // -----------------------------------------------------------------------
    // 体检待办 + 开场消息（纯本地拼装，不调 LLM）
    // -----------------------------------------------------------------------

    internal static List<AuditTask> BuildAuditTasks(JsonNode? analysis)
    {
        var tasks = new List<AuditTask>();
        if (analysis is not JsonObject root) return tasks;

        var sections = root["sections"] as JsonObject;
        foreach (var key in new[] { ResumeSection.Basic, ResumeSection.Works, ResumeSection.Projects, ResumeSection.Skills })
        {
            if (sections?[key] is not JsonArray list) continue;
            for (var i = 0; i < list.Count; i++)
            {
                if (list[i] is not JsonObject it) continue;
                if (ChatProjection.IsTrue(it["applied"])) continue; // 已处理过的跳过
                var raw = ChatProjection.ToJsString(it["severity"]);
                var sev = raw == IssueSeverity.Error ? IssueSeverity.Error
                    : raw == IssueSeverity.Warning ? IssueSeverity.Warning : IssueSeverity.Tip;
                if (sev == IssueSeverity.Tip) continue;
                var problem = ChatProjection.ToJsString(it["problem"]).Trim();
                if (problem.Length == 0) continue;
                var field = ChatProjection.GetStringOr(it["field"], "");
                tasks.Add(new AuditTask(
                    $"issue:{key}:{i}", "issue", sev, problem,
                    $"帮我处理这个问题：{problem}",
                    field.Length > 0 ? field : null));
            }
        }

        if (root["match"] is JsonObject match && match["gaps"] is JsonArray gaps)
            for (var i = 0; i < gaps.Count; i++)
            {
                var text = ChatProjection.ToJsString(gaps[i]).Trim();
                if (text.Length == 0) continue;
                tasks.Add(new AuditTask(
                    $"gap:{i}:{text}", "gap", IssueSeverity.Tip,
                    $"JD 要求但简历未体现：{text}",
                    $"JD 要求「{text}」，帮我在简历里体现"));
            }

        return tasks.Take(20).ToList();
    }

    internal static string BuildOpeningMessage(JsonNode? analysis, List<AuditTask> tasks)
    {
        if (analysis is not JsonObject root)
            return "你好，我是你的简历顾问。\n\n" +
                   "这份简历还没有做过 AI 分析，你可以先跑一次「AI 分析」拿到体检清单；\n" +
                   "也可以直接把想补充的经历贴给我，我帮你整理成条目。";

        string? ats = null;
        if (root["atsScore"] is JsonNode atsNode && atsNode.GetValueKind() == JsonValueKind.Number)
            ats = atsNode.GetValue<JsonElement>().GetRawText();

        var errors = tasks.Count(t => t.Kind == "issue" && t.Severity == IssueSeverity.Error);
        var warnings = tasks.Count(t => t.Kind == "issue" && t.Severity == IssueSeverity.Warning);
        var gaps = tasks.Count(t => t.Kind == "gap");

        var head = $"我已经看过这份简历了。{(ats is not null ? $"当前 ATS 友好度 **{ats}** 分，" : "")}" +
                   $"识别到 **{errors} 个错误**、**{warnings} 处可优化**{(gaps > 0 ? $"、**{gaps} 项 JD 缺口**" : "")}。";

        var lines = new List<string> { head };
        var top = tasks.Take(3).ToList();
        if (top.Count > 0)
        {
            lines.Add("");
            lines.Add("最值得先处理的几件事：");
            for (var i = 0; i < top.Count; i++)
                lines.Add($"{i + 1}. {top[i].Title}{(top[i].Field is not null ? $"（{ResumeEditValidator.BuildFieldLabel(top[i].Field!)}）" : "")}");
        }
        lines.Add("");
        lines.Add("你可以：");
        lines.Add("- 直接把要补充的经历贴给我，我帮你整理成条目");
        if (tasks.Count > 0) lines.Add("- 点下面的待办让我逐个处理");
        lines.Add("- 或者问我任何关于这份简历的问题");
        return string.Join("\n", lines);
    }
}
