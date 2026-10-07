// /ai/chat 与 /ai/revisions 模块（对齐 modules/ai-chat.ts）：
// - 会话 CRUD + 多轮对话（SSE 流式）
// - AI 产出的修改建议经 Services/Edit/ResumeEditValidator 权威校验后下发给前端
// - 统一修订账本（AiRevision）：对话侧与分析侧共用的撤销依据
// 设计约束：本模块不提供任何「直接改简历字段」的接口，写入永远由前端 applyEdit 完成。

using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Ai;
using ResumeAgent.Api.Services.Edit;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Endpoints.Ai;

public static class AiChatEndpoints
{
    // -----------------------------------------------------------------------
    // LLM 输出契约
    // schema 保持扁平（DeepSeek 只有 json_object 模式，复杂 schema 会被忽略）
    // -----------------------------------------------------------------------

    private const string ChatSchema = """
        {
          "type": "object",
          "properties": {
            "reply": { "type": "string" },
            "asks": { "type": "array", "items": { "type": "string" } },
            "edits": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "op": { "type": "string", "enum": ["set", "append"] },
                  "section": { "type": "string" },
                  "field": { "type": "string" },
                  "after": { "type": "string" },
                  "item": { "type": "object" },
                  "reason": { "type": "string" },
                  "risks": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["op", "reason"]
              }
            }
          },
          "required": ["reply", "asks", "edits"]
        }
        """;

    private const string ChatSystemPrompt = "你是资深简历顾问，正在帮用户修改「当前这一份」简历。你只输出 JSON，不要输出任何解释性文字或 markdown 代码块。\n" +
        "\n" +
        "【改写铁律】\n" +
        "1. 绝对不得新增用户没有提供的事实：数字、百分比、公司名、学校名、技术名词、时间、奖项。\n" +
        "2. 以下字段只能「照抄用户原话」，不得自己生成：时间(start/end)、链接(link/url)、联系方式(phone/email)、所在地(location)、薪资(expectedSalary)、出生年月(birthday)、性别(gender)。姓名(name)任何情况都不许写进 edits。\n" +
        "3. 改写只能做：语序调整、动词强化、去掉口语化表达、把已有事实重组为 STAR 结构、补齐标点与量词。\n" +
        "4. 某个字段没有可改的东西，就不要出现在 edits 里。\n" +
        "\n" +
        "【输出结构】\n" +
        "{\n" +
        "  \"reply\": \"给用户看的回复，可用少量 markdown（**粗体**、- 列表）\",\n" +
        "  \"asks\": [\"需要用户补充的信息点，每条一个短问句，最多 4 条\"],\n" +
        "  \"edits\": [\n" +
        "    { \"op\": \"set\", \"field\": \"works[0].description\", \"after\": \"改写后的完整内容\", \"reason\": \"为什么这么改\", \"risks\": [] },\n" +
        "    { \"op\": \"append\", \"section\": \"works\", \"item\": { \"company\": \"公司名\", \"role\": \"职位\", \"start\": \"开始时间\", \"end\": \"结束时间或至今\", \"description\": \"职责与产出\" }, \"reason\": \"为什么新增\", \"risks\": [] },\n" +
        "    { \"op\": \"append\", \"section\": \"projects\", \"item\": { \"name\": \"项目名称\", \"company\": \"所属公司\", \"role\": \"你的角色\", \"start\": \"开始时间\", \"end\": \"结束时间\", \"description\": \"项目内容与成果\" }, \"reason\": \"为什么新增\", \"risks\": [] }\n" +
        "  ]\n" +
        "}\n" +
        "\n" +
        "【edits 的硬性要求】\n" +
        "- edits 里绝对不要出现「建议添加…」「可以补充…」这类文字；要么给出可直接替换的完整正文（op=set），要么把要问的点放进 asks。\n" +
        "- op=set 的 field 必须是「section[下标].字段名」的完整路径，且该条目必须已经存在。\n" +
        "- op=append 用于「用户描述的是一段新经历」。item 里只填用户明确说过的内容；用户没说过的一律留空字符串，绝不编造。\n" +
        "- 时间（start/end）、链接（link）只有用户原话里出现过才能填，且必须照抄用户给的写法（例：用户说「2023年3月入职」就填 \"2023年3月\"）；用户没说就留空，由用户在卡片里补。\n" +
        "\n" +
        "【引导补全：用户给了一段新经历时】\n" +
        "1. 先判断属于哪个 section：\n" +
        "   - works = 在某公司任职（公司、职位、在职时间、职责与产出）\n" +
        "   - projects = 某个具体项目（项目名称、角色、技术/方法、职责与成果）\n" +
        "   - 用户同时给了任职信息和项目信息时，必须**同时**输出两条 append（一条 works、一条 projects），不要只处理其中一种。\n" +
        "   - 用户给的是一段新经历但还不完整时，也要先用 op=append 把已知信息落成条目，缺的部分放进 asks。\n" +
        "2. 各 section 的必填字段（缺失就必须写进 asks，并指明属于哪一段经历）：\n" +
        "   - works：公司名称、职位、开始时间（结束时间/是否至今可选）\n" +
        "   - projects：项目名称（其余可选，但角色、时间、成果尽量追问）\n" +
        "   - educations：学校、开始时间\n" +
        "   - skills：技能分类、技能内容\n" +
        "3. asks 每条一个短问句，带上 section 与条目名称做限定，例：「你在这段 XX 项目里的角色是？（项目经历）」「这段 A 公司经历的结束时间是什么时候？（工作经历）」。\n" +
        "4. 一次最多 4 条 asks，优先问必填缺口；用户已回答过的不要再问。\n" +
        "5. 输出前自查一遍：用户这段话里，属于「任职」的信息是否都进了 works 的 append？属于「项目」的信息是否都进了 projects 的 append？只要用户提到了某个项目/系统/平台/产品，就必须有对应的 projects 条目（信息不全也要先建条目，缺的写进 asks），不允许把它塞进 works.description 就算了。\n" +
        "\n" +
        "【其他】\n" +
        "- 若给了焦点字段，优先围绕焦点回答，但不要忽略用户的实际提问。\n" +
        "- 若给了目标岗位 JD，改写与建议需向 JD 靠拢，但仍不得编造。\n" +
        "- 面向用户阅读的文字（reply、asks 以及 edits 的 reason/risks）提到简历字段时一律用中文名（如「所在地」「职位」「求职意向」「公司名称」），禁止出现 location/role/title 这类英文键名或 JSON 路径。\n" +
        "- 回复用中文，语气专业、简洁。";

    /// <summary>JSON 输出用：不转义中文（对齐 JS JSON.stringify 的原样输出，避免 prompt 体积膨胀）</summary>
    private static readonly JsonSerializerOptions PrettyJsonOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static readonly JsonSerializerOptions NodeJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

    private static string ToIso(DateTime v)
    {
        if (v.Kind == DateTimeKind.Unspecified) v = DateTime.SpecifyKind(v, DateTimeKind.Local);
        return v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
    }

    private static string? ToIsoOrNull(DateTime? v) => v is null ? null : ToIso(v.Value);

    // -----------------------------------------------------------------------
    // 小工具
    // -----------------------------------------------------------------------

    private static List<string> ParseFocus(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return [];
        try
        {
            var node = JsonNode.Parse(raw);
            if (node is not JsonArray arr) return [];
            return arr.Where(x => x is JsonValue v && v.GetValueKind() == JsonValueKind.String)
                .Select(x => x!.GetValue<string>())
                .ToList();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static SessionMeta SessionToMeta(AiChatSession s, int messageCount, string? preview) => new(
        s.Id,
        s.ResumeId,
        s.Title,
        ParseFocus(s.Focus),
        s.Jd,
        messageCount,
        ToIso(s.LastMessageAt),
        // 无摘要时整个键不输出（对齐改造前的「有值才加键」）
        string.IsNullOrEmpty(preview) ? null : preview[..Math.Min(60, preview.Length)]);

    private static ChatMessageRecord MessageToRecord(AiChatMessage r)
    {
        JsonNode? edits = null;
        if (!string.IsNullOrEmpty(r.Edits))
        {
            try { edits = JsonNode.Parse(r.Edits); }
            catch (JsonException) { edits = null; }
        }
        return new ChatMessageRecord(
            r.Id,
            r.SessionId,
            r.Role == ChatMessageRole.Assistant ? ChatMessageRole.Assistant : ChatMessageRole.User,
            r.Content,
            edits,
            ParseAppliedIndexes(r.AppliedIndexes),
            r.Reasoning,
            ToIso(r.CreatedAt));
    }

    private static List<int> ParseAppliedIndexes(string? raw)
    {
        var list = new List<int>();
        if (string.IsNullOrEmpty(raw)) return list;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return list;
            foreach (var el in doc.RootElement.EnumerateArray())
                if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n)) list.Add(n);
        }
        catch (JsonException) { }
        return list;
    }

    private static RevisionRecord RevisionPayload(AiRevision r) => new(
        r.Id,
        r.ResumeId,
        r.UserId,
        r.Source,
        r.Op,
        r.Section,
        r.Field,
        r.Label,
        r.BeforeValue,
        r.AfterValue,
        r.ItemId,
        r.SessionId,
        r.MessageId,
        ToIsoOrNull(r.RevertedAt),
        ToIso(r.CreatedAt));

    private static JsonNode? AnalysisNode(Resume resume) =>
        string.IsNullOrEmpty(resume.AnalysisJson) ? null : TryParseNode(resume.AnalysisJson);

    private static JsonNode? TryParseNode(string text)
    {
        try { return JsonNode.Parse(text); }
        catch (JsonException) { return null; }
    }

    /// <summary>模拟 JS 的 String(x ?? "")：字符串原样、数字取字面量、布尔转字面量，其余为空串</summary>
    private static string ToJsString(JsonNode? n) => n switch
    {
        JsonValue v => v.GetValueKind() switch
        {
            JsonValueKind.String => v.GetValue<string>() ?? "",
            JsonValueKind.Number => v.GetValue<JsonElement>().GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        },
        _ => "",
    };

    /// <summary>仅当是 JSON 字符串时取值（对齐 TS 的 typeof x === "string"）</summary>
    private static string GetStringOr(JsonNode? n, string def) =>
        n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() ?? def : def;

    private static bool IsTrue(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private static JsonElement ToJsonElement(JsonNode? node)
    {
        if (node is null) return default;
        using var doc = JsonDocument.Parse(node.ToJsonString(NodeJsonOptions));
        return doc.RootElement.Clone();
    }

    /// <summary>对齐 JS 的 `Number(x) || def` 再夹取范围（0 与 NaN 都回落默认值）</summary>
    private static int ParseLimit(string? raw, int def, int max)
    {
        var n = int.TryParse((raw ?? "").Trim(), out var parsed) ? parsed : 0;
        if (n == 0) n = def;
        return Math.Min(Math.Max(n, 1), max);
    }

    // -----------------------------------------------------------------------
    // 体检待办 + 开场消息（纯本地拼装，不调 LLM）
    // -----------------------------------------------------------------------

    private static List<AuditTask> BuildAuditTasks(JsonNode? analysis)
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
                if (IsTrue(it["applied"])) continue; // 已处理过的跳过
                var raw = ToJsString(it["severity"]);
                var sev = raw == IssueSeverity.Error ? IssueSeverity.Error
                    : raw == IssueSeverity.Warning ? IssueSeverity.Warning : IssueSeverity.Tip;
                if (sev == IssueSeverity.Tip) continue;
                var problem = ToJsString(it["problem"]).Trim();
                if (problem.Length == 0) continue;
                var field = GetStringOr(it["field"], "");
                tasks.Add(new AuditTask(
                    $"issue:{key}:{i}", "issue", sev, problem,
                    $"帮我处理这个问题：{problem}",
                    field.Length > 0 ? field : null));
            }
        }

        if (root["match"] is JsonObject match && match["gaps"] is JsonArray gaps)
            for (var i = 0; i < gaps.Count; i++)
            {
                var text = ToJsString(gaps[i]).Trim();
                if (text.Length == 0) continue;
                tasks.Add(new AuditTask(
                    $"gap:{i}:{text}", "gap", IssueSeverity.Tip,
                    $"JD 要求但简历未体现：{text}",
                    $"JD 要求「{text}」，帮我在简历里体现"));
            }

        return tasks.Take(20).ToList();
    }

    private static string BuildOpeningMessage(JsonNode? analysis, List<AuditTask> tasks)
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

    // -----------------------------------------------------------------------
    // 用户消息拼装：简历 JSON + @引用 + 焦点 + 待办 + JD
    // -----------------------------------------------------------------------

    /// <summary>只保留长文本字段的精简版简历，用于简历本身超出上下文预算时降级</summary>
    private static JsonObject CompactResume(JsonNode? content)
    {
        var basic = content?["basic"] as JsonObject;
        return new JsonObject
        {
            ["basic"] = new JsonObject
            {
                ["name"] = basic?["name"]?.DeepClone(),
                ["title"] = basic?["title"]?.DeepClone(),
                ["summary"] = basic?["summary"]?.DeepClone(),
                ["currentStatus"] = basic?["currentStatus"]?.DeepClone(),
                ["workYears"] = basic?["workYears"]?.DeepClone(),
            },
            ["works"] = PickList(content?["works"] as JsonArray, ["company", "role", "start", "end", "description"]),
            ["projects"] = PickList(content?["projects"] as JsonArray, ["name", "role", "description"]),
            ["skills"] = PickList(content?["skills"] as JsonArray, ["category", "items"]),
        };
    }

    private static JsonArray PickList(JsonArray? list, string[] keys)
    {
        var outArr = new JsonArray();
        if (list is null) return outArr;
        foreach (var item in list)
        {
            var obj = new JsonObject();
            foreach (var key in keys) obj[key] = item?[key]?.DeepClone();
            outArr.Add(obj);
        }
        return outArr;
    }

    private static readonly Regex RefRegex = new(
        @"@(basic|works|educations|projects|skills)(?:\[([0-9]+)\])?(?:\.([A-Za-z0-9_]+))?",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>解析用户文本里的 @works[0].description 引用，取出对应内容</summary>
    private static List<(string Label, string Value)> ExtractRefs(string userText, ResumeContent content, JsonNode? rawContent)
    {
        var outList = new List<(string Label, string Value)>();
        var seen = new HashSet<string>();
        foreach (Match m in RefRegex.Matches(userText))
        {
            var path = m.Value[1..];
            if (!seen.Add(path)) continue;
            var parsed = ResumeEditValidator.ParseFieldPath(path);
            if (parsed is null) continue;

            string value;
            if (parsed.Key is not null)
            {
                value = ResumeEditValidator.ReadFieldValue(content, path) ?? "";
            }
            else if (parsed.Index is not null)
            {
                var arr = rawContent?[parsed.Section] as JsonArray;
                var item = arr is not null && parsed.Index.Value < arr.Count ? arr[parsed.Index.Value] : null;
                value = item is null ? "null" : item.ToJsonString(PrettyJsonOptions);
            }
            else
            {
                var node = rawContent?[parsed.Section];
                value = node is null ? "null" : node.ToJsonString(PrettyJsonOptions);
            }

            if (value.Length == 0) continue;
            outList.Add((ResumeEditValidator.BuildFieldLabel(path), value[..Math.Min(2000, value.Length)]));
            if (outList.Count >= 5) break;
        }
        return outList;
    }

    private static string BuildChatUserContent(
        JsonNode rawContent, List<string> focus, List<AuditTask> tasks, string? jd, string userText,
        List<(string Label, string Value)> refs, ProfileSnapshotService snapshot)
    {
        var budget = History.ContextCharBudget(snapshot);
        var sanitized = Prompts.SanitizeContent(rawContent.DeepClone())!;
        var pretty = sanitized.ToJsonString(PrettyJsonOptions);
        var json = pretty.Length <= budget ? pretty : CompactResume(sanitized).ToJsonString(PrettyJsonOptions);

        var parts = new List<string> { $"当前简历（敏感信息已脱敏）：\n```json\n{json}\n```" };
        if (refs.Count > 0)
            parts.Add($"用户引用的内容：\n{string.Join("\n", refs.Select(r => $"· {r.Label}：\n{r.Value}"))}");
        if (focus.Count > 0)
            parts.Add($"焦点：{string.Join("、", focus.Select(f => $"{ResumeEditValidator.BuildFieldLabel(f)}（{f}）"))}");
        if (tasks.Count > 0)
            parts.Add("体检待办（系统已识别的待完善项）：\n" + string.Join("\n",
                tasks.Select(t => $"- [{t.Severity}] {t.Title}{(t.Field is not null ? $"（{t.Field}）" : "")}")));
        if (!string.IsNullOrWhiteSpace(jd)) parts.Add($"--- 目标岗位 JD ---\n{jd!.Trim()}");
        parts.Add($"用户提问：\n{userText}");
        return string.Join("\n\n", parts);
    }

    /// <summary>把 AI 回复与 asks 合并成一条可读的 assistant 内容</summary>
    private static string ComposeAssistantContent(string replyText, List<string> asks)
    {
        var blocks = new List<string>();
        if (replyText.Length > 0) blocks.Add(replyText);
        if (asks.Count > 0) blocks.Add("还需要你补充：\n" + string.Join("\n", asks.Select(a => $"- {a}")));
        var text = string.Join("\n\n", blocks);
        return text.Length > 0 ? text : "（AI 未返回文本回复）";
    }

    // -----------------------------------------------------------------------
    // 模块
    // -----------------------------------------------------------------------

    public static IEndpointRouteBuilder MapAiChatEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/ai").RequireAuthorization();

        // -------------------------------------------------------------------
        // 1. 会话列表
        // -------------------------------------------------------------------
        g.MapGet("/chat/sessions", async (ClaimsPrincipal principal, AppDbContext db, HttpContext http) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var query = http.Request.Query;
            var resumeId = query["resumeId"].ToString();
            var archived = query["archived"].ToString();
            if (string.IsNullOrEmpty(resumeId)) return Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);

            var wantArchived = archived == "true";
            var sessions = await db.AiChatSessions.AsNoTracking()
                .Where(s => s.ResumeId == resumeId && s.UserId == userId && s.Archived == wantArchived)
                .OrderByDescending(s => s.LastMessageAt)
                .ToListAsync();

            // 消息数与最后一条摘要（对齐 SESSION_WITH_LAST_MESSAGE 的 _count + take:1）
            var sessionIds = sessions.Select(s => s.Id).ToList();
            var msgs = await db.AiChatMessages.AsNoTracking()
                .Where(m => sessionIds.Contains(m.SessionId))
                .OrderByDescending(m => m.CreatedAt)
                .Select(m => new { m.SessionId, m.Content })
                .ToListAsync();
            var counts = msgs.GroupBy(m => m.SessionId).ToDictionary(x => x.Key, x => x.Count());
            var previews = new Dictionary<string, string>();
            foreach (var m in msgs)
                if (!previews.ContainsKey(m.SessionId)) previews[m.SessionId] = m.Content;

            return Results.Json(new
            {
                sessions = sessions.Select(s => SessionToMeta(
                    s, counts.GetValueOrDefault(s.Id), previews.GetValueOrDefault(s.Id))),
            });
        });

        // -------------------------------------------------------------------
        // 2. 新建会话（可选插入本地拼装的开场消息）
        // -------------------------------------------------------------------
        g.MapPost("/chat/sessions", async (CreateSessionRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var resumeId = body.ResumeId ?? "";
            if (resumeId.Length == 0) return Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);

            var focus = body.Focus ?? [];
            var title = body.Title ?? "";
            if (title.Length == 0) title = "新对话";
            var jd = (body.Jd ?? "").Trim();

            var session = new AiChatSession
            {
                ResumeId = resumeId,
                UserId = userId,
                Title = title[..Math.Min(60, title.Length)],
                Focus = focus.Count > 0 ? JsonSerializer.Serialize(focus, NodeJsonOptions) : null,
                Jd = jd.Length > 0 ? jd : null,
                LastMessageAt = DateTime.Now,
            };
            db.AiChatSessions.Add(session);
            await db.SaveChangesAsync();

            var tasks = BuildAuditTasks(AnalysisNode(resume));
            var messages = new List<ChatMessageRecord>();
            string? preview = null;
            if (body.WithOpening == true)
            {
                var opening = new AiChatMessage
                {
                    SessionId = session.Id,
                    Role = ChatMessageRole.Assistant,
                    Content = BuildOpeningMessage(AnalysisNode(resume), tasks),
                    AppliedIndexes = JsonLiteral.EmptyArray,
                };
                db.AiChatMessages.Add(opening);
                await db.SaveChangesAsync();
                messages.Add(MessageToRecord(opening));
                preview = opening.Content;
            }

            return Results.Json(new
            {
                session = SessionToMeta(session, messages.Count, preview),
                messages,
                tasks,
            });
        });

        // -------------------------------------------------------------------
        // 3. 会话详情（最近 30 条消息 + 体检待办）
        // -------------------------------------------------------------------
        g.MapGet("/chat/sessions/{id}", async (string id, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId) return Error("对话不存在", 404);

            var rows = await db.AiChatMessages.AsNoTracking()
                .Where(m => m.SessionId == id)
                .OrderByDescending(m => m.CreatedAt)
                .Take(30)
                .ToListAsync();
            rows.Reverse();
            var resume = await db.Resumes.AsNoTracking()
                .FirstOrDefaultAsync(r => r.Id == session.ResumeId && r.UserId == userId);
            var count = await db.AiChatMessages.CountAsync(m => m.SessionId == id);
            var preview = await db.AiChatMessages.AsNoTracking()
                .Where(m => m.SessionId == id)
                .OrderByDescending(m => m.CreatedAt)
                .Select(m => m.Content)
                .FirstOrDefaultAsync();

            return Results.Json(new
            {
                session = SessionToMeta(session, count, preview),
                messages = rows.Select(MessageToRecord),
                tasks = resume is null ? new List<AuditTask>() : BuildAuditTasks(AnalysisNode(resume)),
            });
        });

        // -------------------------------------------------------------------
        // 4. 历史消息分页（游标为消息 id）
        // -------------------------------------------------------------------
        g.MapGet("/chat/sessions/{id}/messages", async (string id, ClaimsPrincipal principal, AppDbContext db, HttpContext http) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId) return Error("对话不存在", 404);

            var query = http.Request.Query;
            var before = query["before"].ToString();
            var take = ParseLimit(query["limit"].ToString(), 30, 100);

            DateTime? beforeDate = null;
            if (!string.IsNullOrEmpty(before))
            {
                var anchor = await db.AiChatMessages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == before);
                if (anchor?.SessionId == id) beforeDate = anchor.CreatedAt;
            }

            var rowsQuery = db.AiChatMessages.AsNoTracking().Where(m => m.SessionId == id);
            if (beforeDate is not null) rowsQuery = rowsQuery.Where(m => m.CreatedAt < beforeDate.Value);
            var rows = await rowsQuery.OrderByDescending(m => m.CreatedAt).Take(take).ToListAsync();
            rows.Reverse();

            return Results.Json(new { messages = rows.Select(MessageToRecord) });
        });

        // -------------------------------------------------------------------
        // 5. 更新会话（标题 / 焦点 / JD / 归档）
        // -------------------------------------------------------------------
        g.MapPatch("/chat/sessions/{id}", async (string id, UpdateSessionRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId) return Error("对话不存在", 404);

            var title = body.Title ?? "";
            if (title.Trim().Length > 0)
            {
                var t = title.Trim();
                session.Title = t[..Math.Min(60, t.Length)];
            }
            if (body.Focus is not null)
            {
                var focus = body.Focus.Where(s => !string.IsNullOrEmpty(s)).ToList();
                session.Focus = focus.Count > 0 ? JsonSerializer.Serialize(focus, NodeJsonOptions) : null;
            }
            // 键存在即覆盖：显式 null 与空串都表示清空 JD
            if (body.Jd.ValueKind != JsonValueKind.Undefined)
            {
                var jd = (body.Jd.ValueKind == JsonValueKind.String ? body.Jd.GetString() ?? "" : "").Trim();
                session.Jd = jd.Length > 0 ? jd : null;
            }
            if (body.Archived is not null) session.Archived = body.Archived.Value;

            await db.SaveChangesAsync();

            var count = await db.AiChatMessages.CountAsync(m => m.SessionId == id);
            var preview = await db.AiChatMessages.AsNoTracking()
                .Where(m => m.SessionId == id)
                .OrderByDescending(m => m.CreatedAt)
                .Select(m => m.Content)
                .FirstOrDefaultAsync();
            return Results.Json(new { session = SessionToMeta(session, count, preview) });
        });

        // -------------------------------------------------------------------
        // 6. 删除会话（消息靠外键级联）
        // -------------------------------------------------------------------
        g.MapDelete("/chat/sessions/{id}", async (string id, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId) return Error("对话不存在", 404);
            // 消息由 AiChatMessage_sessionId_fkey（Prisma 建表时定义，ON DELETE CASCADE）自动级联删除
            await db.AiChatSessions.Where(s => s.Id == id).ExecuteDeleteAsync();
            return Results.Json(new { ok = true });
        });

        // -------------------------------------------------------------------
        // 7. 发消息（SSE 流式）
        // -------------------------------------------------------------------
        g.MapPost("/chat/sessions/{id}/messages", async (
            string id, SendMessageRequest body, ClaimsPrincipal principal, AppDbContext db,
            ProfileSnapshotService snapshot, ChatService chat, HttpContext http, CancellationToken ct) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var userText = (body.Content ?? "").Trim();
            if (userText.Length == 0) return Error("消息内容不能为空", 400);

            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId) return Error("对话不存在", 404);

            var resume = await db.Resumes.AsNoTracking()
                .FirstOrDefaultAsync(r => r.Id == session.ResumeId && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);

            if (!snapshot.IsAvailable()) return Error("未配置 AI 模型，无法对话", 400);

            var content = resume.Content;
            var rawContent = JsonSerializer.SerializeToNode(content, NodeJsonOptions)!;
            var focus = ParseFocus(session.Focus);
            var tasks = BuildAuditTasks(AnalysisNode(resume));

            // 历史消息（不含本条）
            var historyRows = await db.AiChatMessages.AsNoTracking()
                .Where(m => m.SessionId == id)
                .OrderBy(m => m.CreatedAt)
                .Select(m => new { m.Role, m.Content })
                .ToListAsync();
            var history = historyRows.Select(m => new HistoryRow(m.Role, m.Content)).ToList();

            // 用户最近说过的话（仅 user 角色，含本条）：事实核验与时间抽取都只认用户自己的话——
            // AI 回复里天然带大量日期，混进来会让「哪段日期属于本条经历」的判断失真。
            var userConvoText = History.GetRecentUserText(history, userText);

            // 先落库用户消息：即使 LLM 失败，用户说的话也不丢
            db.AiChatMessages.Add(new AiChatMessage { SessionId = id, Role = ChatMessageRole.User, Content = userText });
            await db.SaveChangesAsync();

            var sse = new SseWriter(http.Response);
            await sse.InitAsync();

            var reasoningTxt = new StringBuilder();
            try
            {
                var budget = History.ContextCharBudget(snapshot);
                var messages = new List<ChatMessageItem> { new(ChatMessageRole.System, ChatSystemPrompt) };
                messages.AddRange(History.GetHistoryForLLM(history, budget));
                messages.Add(new ChatMessageItem(ChatMessageRole.User, BuildChatUserContent(
                    rawContent, focus, tasks, session.Jd, userText, ExtractRefs(userText, content, rawContent), snapshot)));

                var text = await chat.ChatStreamAsync(
                    messages,
                    new ChatOptionsEx { JsonSchema = ChatSchema, Temperature = 0.4, MaxTokens = 262144 },
                    async d =>
                    {
                        reasoningTxt.Append(d);
                        await sse.SendAsync("reasoning", new { delta = d }, ct);
                    },
                    d => sse.SendAsync("content", new { delta = d }, ct),
                    null, ct);

                if (string.IsNullOrEmpty(text))
                {
                    await SafeSendAsync(sse, "error", new { message = "AI 未返回内容，请重试或检查模型配置" }, ct);
                    return Results.Empty;
                }

                JsonElement parsed = default;
                try
                {
                    using var doc = JsonDocument.Parse(text);
                    parsed = doc.RootElement.Clone();
                }
                catch (JsonException)
                {
                    await SafeSendAsync(sse, "error", new { message = "AI 返回格式异常，请重试" }, ct);
                    return Results.Empty;
                }
                if (parsed.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
                {
                    await SafeSendAsync(sse, "error", new { message = "AI 返回格式异常，请重试" }, ct);
                    return Results.Empty;
                }

                var rawEdits = parsed.ValueKind == JsonValueKind.Object && parsed.TryGetProperty("edits", out var e)
                    ? e
                    : default;
                var (edits, rejected) = ResumeEditValidator.ValidateEdits(rawEdits, content, userText, userConvoText);

                var replyText = parsed.ValueKind == JsonValueKind.Object ? GetStringProperty(parsed, "reply").Trim() : "";
                var llmAsks = parsed.ValueKind == JsonValueKind.Object ? GetStringArray(parsed, "asks") : [];

                // 本地兜底追问：卡片里仍缺必填项的，一定问出来，不依赖模型自觉
                var missingAsks = new List<string>();
                foreach (var edit in edits)
                {
                    if (edit.Op != EditOp.Append || edit.Section == ResumeSection.Basic) continue;
                    var item = edit.Item ?? new ResumeEditItem();
                    var miss = ResumeEditValidator.CheckAppendRequired(edit.Section, item)
                        .Where(m => !llmAsks.Any(a => a.Contains(m)))
                        .ToList();
                    if (miss.Count == 0) continue;
                    var who = new[] { item.Company, item.School, item.Name }
                        .FirstOrDefault(x => !string.IsNullOrEmpty(x));
                    missingAsks.Add($"这段{ResumeEditValidator.SectionLabel(edit.Section)}{(who is not null ? $"（{who}）" : "")}还缺：{string.Join("、", miss)}，发我补上。");
                }
                var asks = llmAsks.Concat(missingAsks).Take(5).ToList();

                var assistant = new AiChatMessage
                {
                    SessionId = id,
                    Role = ChatMessageRole.Assistant,
                    Content = ComposeAssistantContent(replyText, asks),
                    Edits = JsonSerializer.Serialize(edits, AppDbContext.JsonOptions),
                    AppliedIndexes = JsonLiteral.EmptyArray,
                    Reasoning = reasoningTxt.Length > 0 ? reasoningTxt.ToString() : null,
                };
                db.AiChatMessages.Add(assistant);

                var tracked = await db.AiChatSessions.FirstAsync(s => s.Id == id);
                tracked.LastMessageAt = DateTime.Now;
                // 首轮自动命名，便于会话列表辨识
                if (tracked.Title == "新对话") tracked.Title = userText[..Math.Min(20, userText.Length)];
                await db.SaveChangesAsync();

                await CallLog.RecordCallAsync(db, snapshot, userId, LlmCallKind.Chat, session.ResumeId, ok: true,
                    reasoning: reasoningTxt.Length > 0 ? reasoningTxt.ToString() : null, output: text);

                await sse.SendAsync("result", new { message = MessageToRecord(assistant), edits, rejected }, ct);
                await sse.SendAsync("done", new { ok = true }, ct);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[AI-CHAT] 对话失败: {ex.Message}");
                await SafeSendAsync(sse, "error", new { message = "对话失败，请重试" }, ct);
            }
            return Results.Empty;
        });

        // -------------------------------------------------------------------
        // 8. 标记某条建议卡片是否已应用
        // -------------------------------------------------------------------
        g.MapPost("/chat/messages/{id}/edits/{index}/applied", async (
            string id, string index, MarkEditAppliedRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            if (!int.TryParse(index, out var idx) || idx < 0) return Error("index 不合法", 400);

            var msg = await db.AiChatMessages.FirstOrDefaultAsync(m => m.Id == id);
            if (msg is null) return Error("消息不存在", 404);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == msg.SessionId);
            if (session is null || session.UserId != userId) return Error("消息不存在", 404);

            var current = ParseAppliedIndexes(msg.AppliedIndexes);
            // 只有显式 applied=false 才是「取消应用」，其余（缺省/null）都按「已应用」处理
            var applied = body.Applied != false;
            var next = applied
                ? current.Append(idx).Distinct().OrderBy(x => x).ToList()
                : current.Where(x => x != idx).ToList();

            msg.AppliedIndexes = JsonSerializer.Serialize(next, NodeJsonOptions);
            await db.SaveChangesAsync();
            return Results.Json(new { ok = true, message = MessageToRecord(msg) });
        });

        // -------------------------------------------------------------------
        // 9. 权威校验 edits（卡片表单补空后 / 批量应用前调用）
        // -------------------------------------------------------------------
        g.MapPost("/chat/validate-edits", async (ValidateEditsRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var resumeId = body.ResumeId ?? "";
            if (resumeId.Length == 0) return Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);

            var content = resume.Content;
            var (edits, rejected) = ResumeEditValidator.ValidateEdits(
                ToJsonElement(body.Edits), content, body.UserText ?? "");
            // 补充 append 必填项提示，供卡片表单使用
            var missing = edits
                .Select(e => e.Op == EditOp.Append && e.Section != ResumeSection.Basic
                    ? ResumeEditValidator.CheckAppendRequired(e.Section, e.Item ?? new ResumeEditItem())
                    : new List<string>())
                .ToList();
            return Results.Json(new { edits, rejected, missing });
        });

        // -------------------------------------------------------------------
        // 10. 修订账本列表
        // -------------------------------------------------------------------
        g.MapGet("/revisions", async (ClaimsPrincipal principal, AppDbContext db, HttpContext http) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var query = http.Request.Query;
            var resumeId = query["resumeId"].ToString();
            var before = query["before"].ToString();
            if (string.IsNullOrEmpty(resumeId)) return Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);

            var take = ParseLimit(query["limit"].ToString(), 50, 200);

            DateTime? beforeDate = null;
            if (!string.IsNullOrEmpty(before))
            {
                var anchor = await db.AiRevisions.AsNoTracking().FirstOrDefaultAsync(r => r.Id == before);
                if (anchor?.ResumeId == resumeId) beforeDate = anchor.CreatedAt;
            }

            var rowsQuery = db.AiRevisions.AsNoTracking()
                .Where(r => r.ResumeId == resumeId && r.UserId == userId);
            if (beforeDate is not null) rowsQuery = rowsQuery.Where(r => r.CreatedAt < beforeDate.Value);
            var rows = await rowsQuery.OrderByDescending(r => r.CreatedAt).Take(take).ToListAsync();

            return Results.Json(new
            {
                revisions = rows.Select(RevisionPayload),
                // 只允许撤销最新一条未撤销的记录，避免前后依赖错乱
                revertibleId = rows.FirstOrDefault(r => r.RevertedAt is null)?.Id,
            });
        });

        // -------------------------------------------------------------------
        // 11. 记一笔修订（前端保存成功后调用）
        // -------------------------------------------------------------------
        g.MapPost("/revisions", async (CreateRevisionRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var resumeId = body.ResumeId ?? "";
            var op = body.Op ?? "";
            var section = body.Section ?? "";
            if (resumeId.Length == 0) return Error("resumeId 必填", 400);
            if (op != EditOp.Set && op != EditOp.Append) return Error("op 不合法", 400);
            if (section.Length == 0 || !ResumeEditValidator.SettableFields.ContainsKey(section))
                return Error("section 不合法", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);

            var field = body.Field ?? "";
            if (field.Length == 0) field = section;
            var label = (body.Label ?? "").Trim();
            var revision = new AiRevision
            {
                ResumeId = resumeId,
                UserId = userId,
                Source = body.Source == RevisionSource.Analysis ? RevisionSource.Analysis : RevisionSource.Chat,
                Op = op,
                Section = section,
                Field = field,
                Label = label.Length > 0 ? label : ResumeEditValidator.BuildFieldLabel(field),
                BeforeValue = body.BeforeValue,
                AfterValue = body.AfterValue,
                ItemId = body.ItemId,
                SessionId = body.SessionId,
                MessageId = body.MessageId,
            };
            db.AiRevisions.Add(revision);
            await db.SaveChangesAsync();
            return Results.Json(new { revision = RevisionPayload(revision) });
        });

        // -------------------------------------------------------------------
        // 12. 标记已撤销（简历回写由前端完成，服务端只当账本）
        // -------------------------------------------------------------------
        g.MapPatch("/revisions/{id}", async (string id, UpdateRevisionRequest? body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var row = await db.AiRevisions.FirstOrDefaultAsync(r => r.Id == id);
            if (row is null || row.UserId != userId) return Error("记录不存在", 404);

            // reverted=false 表示取消撤销；不带 body（前端即如此调用）或不传该字段都按「标记已撤销」处理
            row.RevertedAt = body?.Reverted == false ? null : DateTime.Now;
            await db.SaveChangesAsync();
            return Results.Json(new { revision = RevisionPayload(row) });
        });

        return app;
    }

    // -----------------------------------------------------------------------
    // JSON 取值辅助
    // -----------------------------------------------------------------------

    private static string GetStringProperty(JsonElement obj, string prop) =>
        obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString()! : "";

    /// <summary>对齐 TS：asks.filter(a =&gt; typeof a === "string" &amp;&amp; !!a.trim()).slice(0, 4)（保留原值不 trim）</summary>
    private static List<string> GetStringArray(JsonElement obj, string prop)
    {
        var list = new List<string>();
        if (!obj.TryGetProperty(prop, out var el) || el.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in el.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) continue;
            var s = item.GetString()!;
            if (s.Trim().Length == 0) continue;
            list.Add(s);
            if (list.Count >= 4) break;
        }
        return list;
    }

    /// <summary>SSE 写入失败（客户端已断开等）不应再把异常抛给上层中间件</summary>
    private static async Task SafeSendAsync(SseWriter sse, string evt, object? data, CancellationToken ct)
    {
        try { await sse.SendAsync(evt, data, ct); }
        catch (Exception) { /* 连接已关闭，忽略 */ }
    }
}