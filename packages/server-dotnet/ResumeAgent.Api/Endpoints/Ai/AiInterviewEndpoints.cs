// AI 模拟面试端点 —— Node 与 .NET 的唯一实现（两边同构，禁止出现第三份）
//
// 与 AiChatEndpoints.cs 的三处刻意差异（这是面试功能能否成立的前提，不要图省事"简化"掉）：
//
// 1. 简历不每轮全量发送。追问时只发 meta.target 指向的那一条——追问必须聚焦到具体条目上才有杀伤力，
//    全量简历反而会让模型去问泛泛的"介绍一下你的项目"。只有开新题时才给全量（它需要知道还有什么可问）。
// 2. 历史不走 Services/Ai/History.cs 的 A 视图。见 InterviewHistory.cs 的文件头说明。
// 3. 产出除点评外还带 questionId / probeDepth / verdict，进 Meta 列供前端渲染与报告聚合。
//
// 【状态机：为什么一次 LLM 调用只做一件事】
// 一条 assistant 消息只能带一个 questionId。如果让模型在"收尾旧题"的同时"开出新题"，
// 这条消息归到哪一组都不对——归新组则旧题丢失判定（报告算分错），归旧组则新题没有 questionId，
// 分组断裂、追问链串不起来。所以强制拆成两次调用：
//   回答后判定 → 若该追问：1 次调用出一条「追问」；
//                 若该收尾：1 次调用出一条「收尾」（IsClosing，question 为空）+ 再 1 次调用出一条「新题」。
// 换题频率低（每题一次），多这一次调用换来状态机无歧义，值。
//
// 设计约束（沿用 chat 的铁律）：本模块不提供任何"直接改简历字段"的接口。
// 追问中挖出的、简历上没写的细节以 edits 卡片产出，必须用户点「应用」才落库——
// 面试是用户主动表达，AI 不得替他确认事实，更不得自动回写。

using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Ai;
using ResumeAgent.Api.Services.Edit;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Endpoints.Ai;

public static class AiInterviewEndpoints
{
    private static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

    private static string ToIso(DateTime v)
    {
        if (v.Kind == DateTimeKind.Unspecified) v = DateTime.SpecifyKind(v, DateTimeKind.Local);
        return v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
    }

    private static async Task SafeSendAsync(SseWriter sse, string evt, object? data, CancellationToken ct)
    {
        try { await sse.SendAsync(evt, data, ct); }
        catch (Exception ex) { Console.Error.WriteLine($"[AI-INTERVIEW] SSE 推送失败: {ex.Message}"); }
    }

    // 以下取值一律走 Prop：JsonNode 的字符串索引器在非 JsonObject 上会抛
    // "The node must be of type 'JsonObject'"，模型偶尔返回数组/标量时不能让它炸掉整轮。
    private static JsonNode? Prop(JsonNode? node, string key) =>
        node is JsonObject o ? o[key] : null;

    /// <summary>
    /// 换题时挑考察条目。
    /// 优先尊重模型选的 target（允许隔题复用同一条目——不同维度问同一个项目是合理的），
    /// 但**连续两题撞同一个条目**时强制换一个，否则会出现「刚问完又问一遍」。
    /// </summary>
    private static string? PickNextTarget(
        ResumeContent content, string? modelTarget, string? lastTarget, List<string> covered)
    {
        if (!string.IsNullOrEmpty(modelTarget) && modelTarget != lastTarget) return modelTarget;
        if (!string.IsNullOrEmpty(modelTarget) && lastTarget is null) return modelTarget;
        // 元组是值类型，不能用 ?.；没找到时 Path 为 null，回退到模型选的那个
        var found = InterviewHistory.ListAskableItems(content)
            .FirstOrDefault(a => a.Path != lastTarget && !covered.Contains(a.Path));
        return found.Path ?? modelTarget;
    }

    private static JsonElement RawEdits(JsonObject o) =>
        o["edits"] is null ? default : JsonSerializer.Deserialize<JsonElement>(o["edits"]!.ToJsonString());

    private static string StrOf(JsonObject o, string key, int max) =>
        InterviewHistory.CleanText(Prop(o, key), max) ?? "";

    private static string? StrOrNull(JsonObject o, string key, int max) =>
        InterviewHistory.CleanText(Prop(o, key), max);

    private static List<string> StrArray(JsonObject o, string key) =>
        InterviewHistory.StrArray(o, key);

    private static List<string> MergeCovered(IEnumerable<string> a, IEnumerable<string> b)
    {
        var seen = new HashSet<string>();
        var list = new List<string>();
        foreach (var x in a.Concat(b))
        {
            if (!string.IsNullOrWhiteSpace(x) && seen.Add(x)) list.Add(x);
        }
        return list;
    }

    private static JsonObject? ParseObject(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        try { return JsonNode.Parse(text!) as JsonObject; }
        catch (JsonException) { return null; }
    }

    private static string NewQuestionId(int seq) => $"q{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}{seq}";

    /// <summary>
    /// 兜底探针：组装完 prompt 后估算总量，超出「上下文 - 输出预留」就打 warn。
    /// 不阻断请求——预算分配已经保证不会真爆，这条只是让你能发现哪些「模型 × 简历」组合顶到了墙。
    /// </summary>
    private static void AssertWithinContext(IReadOnlyList<ChatMessageItem> messages, string label, ProfileSnapshotService snapshot)
    {
        var cfg = snapshot.GetConfig();
        var maxContext = cfg?.MaxContext ?? 32768;
        var maxOutput = cfg?.MaxOutput ?? 4096;
        var total = messages.Sum(m => m.Content.Length);
        var limit = Math.Max(1024, maxContext - maxOutput);
        if (total > limit)
        {
            Console.Error.WriteLine(
                $"[AI-INTERVIEW] {label} prompt 约 {total} 字符，可能超出 {cfg?.Provider.ToString() ?? "?"}/{cfg?.Model ?? "?"} 的可用上下文 {limit}（maxContext {maxContext} - maxOutput {maxOutput}）");
        }
    }

    // -----------------------------------------------------------------------
    // User message 拼装
    // -----------------------------------------------------------------------

    private static string BuildUserContent(
        ResumeContent content,
        string? target,
        AssembledHistory history,
        bool withChain,
        string instruction,
        string? userText,
        string? targetRole,
        ProfileSnapshotService snapshot)
    {
        var parts = new List<string>();

        // 简历：追问轮只给本轮那一条，开新题轮给全量（它要知道还有什么可问）
        var slice = withChain ? InterviewHistory.SliceTarget(content, target) : null;
        if (slice is not null)
        {
            parts.Add($"【本轮考察的简历条目：{slice.Value.Label}】\n```json\n" +
                      $"{InterviewHistory.ToPromptJson(slice.Value.Item, snapshot)}\n```");
        }
        else
        {
            var (json, trimmed) = InterviewHistory.FitResumeJson(content, (int)Math.Floor(History.ContextCharBudget(snapshot) * 0.35));
            parts.Add($"【候选人简历（敏感信息已脱敏{(trimmed ? "，篇幅已精简" : "")}）】\n```json\n{json}\n```");
        }

        if (!string.IsNullOrWhiteSpace(targetRole)) parts.Add($"【面试岗位】\n{targetRole!.Trim()}");

        var askable = InterviewHistory.ListAskableItems(content);
        parts.Add("【可考察的简历条目（target 只能取这些值之一）】\n" +
                  (askable.Count == 0 ? "（无）" : string.Join("\n", askable.Select(a => $"{a.Path} = {a.Label}"))));

        if (history.Plan is not null)
        {
            parts.Add($"【你此前给出的面试计划】共 {history.Plan.QuestionCount?.ToString() ?? "?"} 题，" +
                      $"已覆盖：{(history.Covered.Count == 0 ? "（无）" : string.Join("、", history.Covered))}");
        }

        if (history.Digest.Count > 0)
            parts.Add($"【已问过的题（摘要，不要重复提问）】\n{string.Join("\n", history.Digest)}");

        if (history.Chain.Count > 0)
        {
            parts.Add("【当前追问链（逐字原文，用户的回答细节是判定的唯一依据）】");
            foreach (var m in history.Chain)
            {
                var who = m.Role == ChatMessageRole.Assistant ? "面试官" : "候选人";
                parts.Add($"{who}：{m.Content}");
            }
        }

        if (history.Covered.Count > 0)
            parts.Add($"【已覆盖的简历条目】{string.Join("、", history.Covered)}（开新题时必须换一条没覆盖过的）");

        if (!string.IsNullOrEmpty(userText)) parts.Add($"【用户本轮回答】\n{userText}");
        parts.Add($"【本轮指令】\n{instruction}");

        return string.Join("\n\n", parts);
    }

    // -----------------------------------------------------------------------
    // 报告正文：LLM 写文字总结；没配模型或调用失败时用本地数据兜底，保证一定有报告
    // -----------------------------------------------------------------------

    private static async Task<string> BuildReportTextAsync(
        AssembledHistory history, InterviewReport report,
        ProfileSnapshotService snapshot, ChatService chat, SseWriter sse, CancellationToken ct)
    {
        var head = "## 面试报告\n\n" +
                   $"**综合 {report.AvgScore} 分** ｜ 真实性核验 {report.Authenticity.Score} 分（{report.Authenticity.Samples} 题）" +
                   $" ｜ 技术深度 {report.Depth.Score} 分（{report.Depth.Samples} 题）" +
                   $" ｜ 作答 {report.AnsweredCount} 题" +
                   (report.QuestionCount > report.AnsweredCount
                       ? $"（另跳过 {report.QuestionCount - report.AnsweredCount} 题未作答，不计分）"
                       : "");

        var fallback = head + "\n\n" + (
            report.Questions.Count > 0
                ? "### 逐题要点\n" + string.Join("\n", report.Questions.Select((q, i) =>
                {
                    var q1 = q.Question.Replace('\n', ' ');
                    return $"{i + 1}. [{InterviewPrompts.DimensionLabelOf(q.Dimension)}{(q.TargetLabel is null ? "" : $" · {q.TargetLabel}")}] " +
                           $"{q1[..Math.Min(100, q1.Length)]}" +
                           (q.Skipped
                               ? " —— **已跳过，未作答，不计分**"
                               : $"{(q.Verdict is null ? "" : $" —— {q.Verdict}")}{(q.Score is null ? "" : $" {q.Score} 分")}" +
                                 $"{(q.Rounds is { Count: > 1 } ? $"\n   分数轨迹：{string.Join(" → ", q.Rounds.Select(r => r.Score?.ToString() ?? "—"))}" : "")}") +
                           $"{(q.Gap is null ? "" : $"\n   缺口：{q.Gap}")}";
                }))
                : "本场没有有效作答记录。") +
            "\n\n> 模型未生成文字总结（未配置模型或调用失败），以上为本地聚合结果。";

        if (!snapshot.IsAvailable()) return fallback;

        var digest = string.Join("\n", InterviewHistory.TrimDigest(history.Digest, InterviewHistory.Budgets(snapshot).Digest));
        if (digest.Length == 0) digest = "（无有效记录）";
        var messages = new List<ChatMessageItem>
        {
            new(ChatMessageRole.System, InterviewPrompts.ReportSystemPrompt),
            new(ChatMessageRole.User,
                $"【逐题摘要】\n{digest}\n\n【统计】综合 {report.AvgScore} 分；真实性核验 {report.Authenticity.Score} 分（{report.Authenticity.Samples} 题）；" +
                $"技术深度 {report.Depth.Score} 分（{report.Depth.Samples} 题）。\n\n请按 JSON Schema 输出总结报告。"),
        };

        // 用流式版：报告的思考过程也能实时推给前端
        var text = await chat.ChatStreamAsync(
            messages,
            new ChatOptionsEx { JsonSchema = InterviewPrompts.ReportSchema, Temperature = 0.4, MaxTokens = 2048 },
            async d => await SafeSendAsync(sse, "reasoning", new { delta = d }, ct),
            null, null, ct);
        AssertWithinContext(messages, "面试报告", snapshot);

        var parsed = ParseObject(text);
        if (parsed is null || parsed["overall"] is null) return fallback;

        string Section(string title, string key)
        {
            var items = StrArray(parsed, key);
            return items.Count == 0 ? "" : $"### {title}\n{string.Join("\n", items.Select(x => $"- {x}"))}";
        }

        return string.Join("\n\n", new[]
        {
            head,
            $"### 总评\n{StrOf(parsed, "overall", 1000)}",
            Section("做得好的", "strengths"),
            Section("短板", "weaknesses"),
            Section("接下来怎么做", "actions"),
        }.Where(x => x.Length > 0));
    }

    // -----------------------------------------------------------------------
    // 开一道新题：独立的一次 LLM 调用，直接落库并返回完整消息记录
    // （与判定轮分开，保证一条消息只归属一道题——见文件头「状态机」）
    // -----------------------------------------------------------------------

    private static async Task<(ChatMessageRecord Record, List<string> Covered, List<ResumeEdit> Edits)?>
        OpenNewQuestionAsync(
            AppDbContext db, ChatService chat, ProfileSnapshotService snapshot, SseWriter sse,
            ResumeContent content, List<InterviewRawRow> rows, AssembledHistory history,
            IReadOnlyList<string> extraDigest,
            string sessionId, string? targetRole, string userId, string resumeId, CancellationToken ct)
    {
        // 维度由服务端强制交替：统计已出题各维度的数量，少的那个就是本题要考的。
        // 不信任模型自选的 dimension —— 实测它会整场重复同一个维度。
        var askedDims = InterviewHistory.GroupByQuestion(rows)
            .Select(g => InterviewHistory.ParseMeta(
                g.Rows.FirstOrDefault(r => r.Role == ChatMessageRole.Assistant)?.Meta)?.Dimension)
            .ToList();
        var dimension = askedDims.Count > 0
            ? InterviewHistory.NextDimension(askedDims)
            : InterviewDimension.Authenticity;

        var userContent = BuildUserContent(
            content, null,
            // 摘要统一在这里再封顶一次：调用方传来的 digest 可能还没把「刚结束的那题」算进去
            history with
            {
                Digest = InterviewHistory.TrimDigest(
                    extraDigest.Concat(history.Digest).ToList(),
                    InterviewHistory.Budgets(snapshot).Digest),
            },
            withChain: false,
            InterviewPrompts.NextQuestionInstruction + "\n本题维度已指定为 **"
                + InterviewPrompts.DimensionLabelOf(dimension) + "**（dimension 字段填 \"" + dimension + "\"），必须围绕这个维度提问。",
            null, targetRole, snapshot);

        var messages = new List<ChatMessageItem>
        {
            new(ChatMessageRole.System, InterviewPrompts.InterviewSystemPrompt),
            new(ChatMessageRole.User, userContent),
        };
        AssertWithinContext(messages, "开新题", snapshot);

        var text = await chat.ChatStreamAsync(
            messages,
            new ChatOptionsEx { JsonSchema = InterviewPrompts.InterviewSchema, Temperature = 0.7, MaxTokens = 4096 },
            async d => await SafeSendAsync(sse, "reasoning", new { delta = d }, ct),
            d => sse.SendAsync("content", new { delta = d }, ct), null, ct);

        var parsed = ParseObject(text);
        if (parsed is null) return null;

        var question = StrOrNull(parsed, "question", 500);
        if (question is null) return null;

        var rawTarget = InterviewHistory.NormalizeTarget(Prop(parsed, "target"));
        // 连续两题撞同一条目时强制换一个（隔题复用同一条目是允许的）
        var target = PickNextTarget(content, rawTarget, InterviewHistory.LastTargetOf(rows), history.Covered);
        var covered = MergeCovered(history.Covered, StrArray(parsed, "covered"));
        if (target is not null) covered = MergeCovered(covered, [target]);

        var meta = new InterviewTurnMeta
        {
            // 強制维度（服务端按已出题数交替），不采用模型返回的 dimension
            Dimension = dimension,
            ProbeDepth = 0,
            QuestionId = NewQuestionId(covered.Count),
            IsClosing = false,
            Covered = covered,
            Target = target,
            TargetLabel = target is null ? null : ResumeEditValidator.BuildFieldLabel(target),
        };

        var (edits, _) = ResumeEditValidator.ValidateEdits(RawEdits(parsed), content, "", "");
        var body = string.Join("\n\n", new[]
        {
            StrOrNull(parsed, "reply", 1000),
            $"**换题 · {InterviewPrompts.DimensionLabelOf(meta.Dimension)}{(meta.TargetLabel is null ? "" : $" · {meta.TargetLabel}")}**：{question}",
        }.Where(x => !string.IsNullOrEmpty(x)));

        var row = new AiChatMessage
        {
            SessionId = sessionId,
            Role = ChatMessageRole.Assistant,
            Content = body,
            Edits = JsonSerializer.Serialize(edits, AppDbContext.JsonOptions),
            AppliedIndexes = JsonLiteral.EmptyArray,
            Meta = InterviewHistory.SerializeMeta(meta),
            CreatedAt = DateTime.Now,
        };
        db.AiChatMessages.Add(row);
        await db.SaveChangesAsync(ct);

        await CallLog.RecordCallAsync(db, snapshot, userId, LlmCallKind.Interview, resumeId, true, null, text);

        return (
            new ChatMessageRecord(
                row.Id, row.SessionId, row.Role, row.Content,
                JsonNode.Parse(row.Edits ?? "[]"), [], null, ToIso(row.CreatedAt),
                JsonNode.Parse(row.Meta!)),
            covered,
            edits);
    }

    // -----------------------------------------------------------------------
    // 路由
    // -----------------------------------------------------------------------

    public static IEndpointRouteBuilder MapAiInterviewEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/ai").RequireAuthorization();

        // -------------------------------------------------------------------
        // 1. 面试会话列表（只列 mode=interview）
        // -------------------------------------------------------------------
        g.MapGet("/interview/sessions", async (
            HttpContext http, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var resumeId = http.Request.Query["resumeId"].ToString();
            if (string.IsNullOrEmpty(resumeId)) return Error("resumeId 必填", 400);
            if (!await db.Resumes.AsNoTracking().AnyAsync(r => r.Id == resumeId && r.UserId == userId))
                return Error("简历不存在", 404);

            var sessions = await db.AiChatSessions.AsNoTracking()
                .Where(s => s.ResumeId == resumeId && s.UserId == userId && s.Mode == SessionMode.Interview)
                .OrderByDescending(s => s.LastMessageAt)
                .ToListAsync();

            // 消息数与最后一条摘要（与 chat 列表同一写法：实体无 Messages 导航属性，只能分两次查）
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
                sessions = sessions.Select(s => new InterviewSessionMeta(
                    s.Id, s.ResumeId, s.Title,
                    // Focus / Jd 仅为与前端 ChatSessionMeta 结构兼容而存在（面试不用）
                    [], null, s.TargetRole, counts.GetValueOrDefault(s.Id), ToIso(s.LastMessageAt),
                    previews.GetValueOrDefault(s.Id) is { Length: > 0 } p
                        ? p[..Math.Min(60, p.Length)]
                        : null)),
            });
        });

        // -------------------------------------------------------------------
        // 2. 新建面试会话（SSE：流式产出面试计划 + 第一题，合成一条消息）
        // -------------------------------------------------------------------
        g.MapPost("/interview/sessions", async (
            HttpContext http, ClaimsPrincipal principal, AppDbContext db,
            ChatService chat, ProfileSnapshotService snapshot, CancellationToken ct) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var body = await http.Request.ReadFromJsonAsync<CreateInterviewSessionRequest>(ct);
            if (body is null || string.IsNullOrEmpty(body.ResumeId)) return Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking()
                .FirstOrDefaultAsync(r => r.Id == body.ResumeId && r.UserId == userId, ct);
            if (resume is null) return Error("简历不存在", 404);
            if (!snapshot.IsAvailable()) return Error("未配置 AI 模型，无法开始面试", 400);

            var content = resume.Content;
            var targetRole = (body.TargetRole ?? "").Trim();
            if (targetRole.Length == 0) targetRole = (content.Basic.Title ?? "").Trim();
            if (targetRole.Length > 60) targetRole = targetRole[..60];
            if (targetRole.Length == 0) targetRole = null;

            var title = (body.Title ?? "").Trim();
            if (title.Length == 0) title = targetRole is null ? "模拟面试" : $"模拟面试 · {targetRole}";
            if (title.Length > 60) title = title[..60];

            // 注意：session 在 LLM 成功之后才创建（见下方 try 块）。
            // 反过来做的话，模型不可用/返回异常时会留下一条「有会话、但没有开题消息」的残缺记录，
            // 用户在这样的会话里作答时 CurrentTurnState 找不到任何在追问的题，追问层数会一直卡在第 1 层。

            var sse = new SseWriter(http.Response);
            await sse.InitAsync();

            try
            {
                var messages = new List<ChatMessageItem>
                {
                    new(ChatMessageRole.System, InterviewPrompts.InterviewSystemPrompt),
                    new(ChatMessageRole.User,
                        BuildUserContent(content, null, new AssembledHistory([], [], [], null),
                            withChain: false,
                            InterviewPrompts.FirstTurnInstruction
                                + "\n本题维度已指定为 **真实性核验**（dimension 填 \"authenticity\"），后续题目会由系统交替到技术深度。",
                            null, targetRole, snapshot)),
                };
                AssertWithinContext(messages, "面试计划", snapshot);

                var reasoning = new StringBuilder();
                var text = await chat.ChatStreamAsync(
                    messages,
                    new ChatOptionsEx { JsonSchema = InterviewPrompts.InterviewSchema, Temperature = 0.6, MaxTokens = 8192 },
                    async d =>
                    {
                        reasoning.Append(d);
                        await SafeSendAsync(sse, "reasoning", new { delta = d }, ct);
                    },
                    d => sse.SendAsync("content", new { delta = d }, ct), null, ct);

                if (string.IsNullOrEmpty(text))
                {
                    await SafeSendAsync(sse, "error", new { message = "AI 未返回内容，请重试或检查模型配置" }, ct);
                    return Results.Empty;
                }
                var parsed = ParseObject(text);
                if (parsed is null)
                {
                    await SafeSendAsync(sse, "error", new { message = "AI 返回格式异常，请重试" }, ct);
                    return Results.Empty;
                }

                // 到这里才落库：任何一步失败都不会留下残缺会话
                var session = new AiChatSession
                {
                    ResumeId = body.ResumeId,
                    UserId = userId,
                    Title = title,
                    Mode = SessionMode.Interview,
                    TargetRole = targetRole,
                    LastMessageAt = DateTime.Now,
                    CreatedAt = DateTime.Now,
                };
                db.AiChatSessions.Add(session);
                await db.SaveChangesAsync(ct);

                var target = InterviewHistory.NormalizeTarget(Prop(parsed, "target"));
                var planTotal = Prop(parsed, "planTotal") is JsonValue pv && pv.GetValueKind() == JsonValueKind.Number
                    ? Math.Clamp((int)Math.Round(pv.GetValue<double>()), 0, 100)
                    : 5;
                var meta = new InterviewTurnMeta
                {
                    // 强制维度：首题固定为真实性核验（这是本功能的招牌），后续由系统交替
                    Dimension = InterviewDimension.Authenticity,
                    ProbeDepth = 0,
                    QuestionId = NewQuestionId(0),
                    IsPlan = true,
                    IsClosing = false,
                    // 题数：用户指定优先，否则用面试官的建议（缺省 5）
                    QuestionCount = body.QuestionCount is > 0
                        ? Math.Min(body.QuestionCount.Value, InterviewPrompts.MaxQuestions)
                        : planTotal,
                    Covered = target is null ? [] : [target],
                    Target = target,
                    TargetLabel = target is null ? null : ResumeEditValidator.BuildFieldLabel(target),
                };

                var assistant = new AiChatMessage
                {
                    SessionId = session.Id,
                    Role = ChatMessageRole.Assistant,
                    Content = string.Join("\n\n", new[]
                    {
                        StrOrNull(parsed, "reply", 4000),
                        $"**第 1 题**（{InterviewPrompts.DimensionLabelOf(meta.Dimension)}{(meta.TargetLabel is null ? "" : $" · {meta.TargetLabel}")}）：{StrOf(parsed, "question", 500)}",
                    }.Where(x => !string.IsNullOrEmpty(x))),
                    Edits = JsonLiteral.EmptyArray,
                    AppliedIndexes = JsonLiteral.EmptyArray,
                    Meta = InterviewHistory.SerializeMeta(meta),
                    Reasoning = reasoning.Length == 0 ? null : reasoning.ToString(),
                    CreatedAt = DateTime.Now,
                };
                db.AiChatMessages.Add(assistant);
                await db.SaveChangesAsync(ct);

                await CallLog.RecordCallAsync(db, snapshot, userId, LlmCallKind.Interview, session.ResumeId, true,
                    assistant.Reasoning, text);

                await SafeSendAsync(sse, "result", new
                {
                    sessionId = session.Id,
                    targetRole,
                    message = new
                    {
                        assistant.Id,
                        sessionId = assistant.SessionId,
                        role = assistant.Role,
                        assistant.Content,
                        meta,
                        edits = (JsonNode?)null,
                        appliedIndexes = Array.Empty<int>(),
                        createdAt = ToIso(assistant.CreatedAt),
                    },
                }, ct);
                await SafeSendAsync(sse, "done", new { ok = true }, ct);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[AI-INTERVIEW] 生成面试计划失败: {ex}");
                await SafeSendAsync(sse, "error", new { message = "生成面试计划失败，请重试" }, ct);
            }
            return Results.Empty;
        });

        // -------------------------------------------------------------------
        // 3. 会话详情（全部消息，含 meta）
        // -------------------------------------------------------------------
        g.MapGet("/interview/sessions/{id}", async (
            string id, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking()
                .FirstOrDefaultAsync(s => s.Id == id && s.UserId == userId && s.Mode == SessionMode.Interview);
            if (session is null) return Error("面试会话不存在", 404);

            var rows = await db.AiChatMessages.AsNoTracking()
                .Where(m => m.SessionId == id).OrderBy(m => m.CreatedAt).ToListAsync();

            var messages = rows.Select(r => new ChatMessageRecord(
                r.Id, r.SessionId, r.Role, r.Content,
                string.IsNullOrEmpty(r.Edits) ? null : JsonNode.Parse(r.Edits),
                [],
                r.Reasoning,
                ToIso(r.CreatedAt),
                string.IsNullOrEmpty(r.Meta) ? null : JsonNode.Parse(r.Meta))).ToList();

            return Results.Json(new
            {
                session = new InterviewSessionMeta(
                    session.Id, session.ResumeId, session.Title, [], null, session.TargetRole,
                    messages.Count, ToIso(session.LastMessageAt)),
                messages,
            });
        });

        // -------------------------------------------------------------------
        // 4. 重命名面试会话
        // -------------------------------------------------------------------
        g.MapPatch("/interview/sessions/{id}", async (
            string id, ClaimsPrincipal principal, AppDbContext db,
            RenameInterviewSessionRequest body, CancellationToken ct) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.FirstOrDefaultAsync(s => s.Id == id && s.UserId == userId, ct);
            if (session is null) return Error("面试不存在", 404);
            var title = (body.Title ?? "").Trim();
            if (title.Length == 0) return Error("标题不能为空", 400);
            session.Title = title[..Math.Min(60, title.Length)];
            await db.SaveChangesAsync(ct);
            return Results.Json(new { session = new { session.Id, session.Title } });
        });

        // -------------------------------------------------------------------
        // 5. 删除面试会话
        // -------------------------------------------------------------------
        g.MapDelete("/interview/sessions/{id}", async (
            string id, ClaimsPrincipal principal, AppDbContext db, CancellationToken ct) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.FirstOrDefaultAsync(s => s.Id == id && s.UserId == userId, ct);
            if (session is null) return Error("面试不存在", 404);
            db.AiChatSessions.Remove(session);
            await db.SaveChangesAsync(ct);
            return Results.Json(new { ok = true });
        });

        // -------------------------------------------------------------------
        // 6. 面试报告（分数本地聚合，文字总结读缓存的 report 消息）
        // -------------------------------------------------------------------
        g.MapGet("/interview/sessions/{id}/report", async (
            string id, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking()
                .FirstOrDefaultAsync(s => s.Id == id && s.UserId == userId && s.Mode == SessionMode.Interview);
            if (session is null) return Error("面试会话不存在", 404);

            var rows = await ReadRawRowsAsync(db, id);
            var plan = rows.Select(r => InterviewHistory.ParseMeta(r.Meta)).FirstOrDefault(m => m?.IsPlan == true);
            var reportRow = rows.FirstOrDefault(r => InterviewHistory.ParseMeta(r.Meta)?.IsReport == true);

            var report = InterviewHistory.Aggregate(
                id, rows, plan?.QuestionCount ?? 0, reportRow is not null);
            return Results.Json(new { report, text = reportRow?.Content });
        });

        // -------------------------------------------------------------------
        // 7. 发消息（SSE）
        //    action=answer 判定当前回答 → 追问 or 收尾（收尾会再开新题，两次调用）
        //    action=next   跳过当前题，直接开新题
        //    action=finish 结束并出报告
        // -------------------------------------------------------------------
        g.MapPost("/interview/sessions/{id}/messages", async (
            string id, HttpContext http, ClaimsPrincipal principal, AppDbContext db,
            ChatService chat, ProfileSnapshotService snapshot, CancellationToken ct) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var body = await http.Request.ReadFromJsonAsync<SendInterviewMessageRequest>(ct);
            var action = string.IsNullOrEmpty(body?.Action) ? InterviewAction.Answer : body!.Action!;
            if (action is not (InterviewAction.Answer or InterviewAction.Next or InterviewAction.Finish))
                return Error("action 不合法", 400);

            var userText = (body?.Content ?? "").Trim();
            if (userText.Length > 8000) userText = userText[..8000];
            if (action == InterviewAction.Answer && userText.Length == 0) return Error("回答不能为空", 400);

            var session = await db.AiChatSessions.FirstOrDefaultAsync(
                s => s.Id == id && s.UserId == userId && s.Mode == SessionMode.Interview, ct);
            if (session is null) return Error("面试会话不存在", 404);
            var resume = await db.Resumes.AsNoTracking()
                .FirstOrDefaultAsync(r => r.Id == session.ResumeId && r.UserId == userId, ct);
            if (resume is null) return Error("简历不存在", 404);
            if (!snapshot.IsAvailable()) return Error("未配置 AI 模型，无法继续面试", 400);

            var content = resume.Content;

            // 直读原始行（不截断 meta），定位当前题与深度
            var rows = await ReadRawRowsAsync(db, id);
            var (currentQid, currentDepth) = InterviewHistory.CurrentTurnState(rows);

            // 用户回答先落库：LLM 失败也不丢用户的作答。
            // 记下完整行，SSE result 里要回传——前端是乐观上屏的，若不回传会把自己那条删掉且补不回来，
            // 导致「已作答」被误判成「已跳过」。
            ChatMessageRecord? userRecord = null;
            if (action == InterviewAction.Answer)
            {
                var userRow = new AiChatMessage
                {
                    SessionId = id,
                    Role = ChatMessageRole.User,
                    Content = userText,
                    Meta = JsonSerializer.Serialize(
                        new { questionId = currentQid, answered = userText[..Math.Min(200, userText.Length)] },
                        AppDbContext.JsonOptions),
                    CreatedAt = DateTime.Now,
                };
                db.AiChatMessages.Add(userRow);
                await db.SaveChangesAsync(ct);
                userRecord = new ChatMessageRecord(
                    userRow.Id, userRow.SessionId, userRow.Role, userRow.Content,
                    null, [], null, ToIso(userRow.CreatedAt),
                    JsonNode.Parse(userRow.Meta!));
            }

            var sse = new SseWriter(http.Response);
            await sse.InitAsync();
            var reasoning = new StringBuilder();

            try
            {
                // ================= 分支 A：结束面试，出报告 =================
                if (action == InterviewAction.Finish)
                {
                    var history = InterviewHistory.Build(rows, null, InterviewHistory.Budgets(snapshot)); // 报告不需要保留链，只要摘要
                    var report = InterviewHistory.Aggregate(id, rows, history.Plan?.QuestionCount ?? 0, true);
                    var reportText = await BuildReportTextAsync(history, report, snapshot, chat, sse, ct);

                    var meta = new InterviewTurnMeta
                    {
                        Dimension = InterviewDimension.Authenticity,
                        ProbeDepth = 0,
                        QuestionId = "report",
                        IsReport = true,
                        QuestionCount = report.QuestionCount,
                        Score = report.AvgScore,
                        Covered = report.Questions.Where(q => q.Target is not null).Select(q => q.Target!).ToList(),
                    };
                    var reportMsg = new AiChatMessage
                    {
                        SessionId = id,
                        Role = ChatMessageRole.Assistant,
                        Content = reportText,
                        Edits = JsonLiteral.EmptyArray,
                        AppliedIndexes = JsonLiteral.EmptyArray,
                        Meta = InterviewHistory.SerializeMeta(meta),
                        CreatedAt = DateTime.Now,
                    };
                    db.AiChatMessages.Add(reportMsg);
                    session.LastMessageAt = DateTime.Now;
                    await db.SaveChangesAsync(ct);

                    await SafeSendAsync(sse, "result", new
                    {
                        message = ToRecord(reportMsg, meta),
                        report,
                    }, ct);
                    await SafeSendAsync(sse, "done", new { ok = true }, ct);
                    return Results.Empty;
                }

                // ================= 分支 B：判定当前回答 =================
                if (action == InterviewAction.Answer)
                {
                    var budgets = InterviewHistory.Budgets(snapshot);
                    var history = InterviewHistory.Build(rows, currentQid, budgets);
                    var depth = InterviewHistory.SafeDepth(currentDepth);
                    var followTarget = InterviewHistory.LastTargetOf(rows); // 追问不换考察对象
                    var canFollow = depth < InterviewPrompts.MaxProbeDepth;
                    // 维度沿用本题开题时定的那个（服务端强制交替过）。必须在构造 instruction 之前算出来，
                    // 它只读 rows、不依赖 LLM 响应。
                    var dimension = InterviewHistory.QuestionDimensionOf(rows) ?? InterviewDimension.Authenticity;

                    var messages = new List<ChatMessageItem>
                    {
                        new(ChatMessageRole.System, InterviewPrompts.InterviewSystemPrompt),
                        new(ChatMessageRole.User, BuildUserContent(
                            content, followTarget, history, withChain: true,
                            InterviewPrompts.JudgeInstructionAt(depth, dimension), userText, session.TargetRole, snapshot)),
                    };
                    AssertWithinContext(messages, $"判定轮(depth={depth})", snapshot);

                    var text = await chat.ChatStreamAsync(
                        messages,
                        new ChatOptionsEx { JsonSchema = InterviewPrompts.InterviewSchema, Temperature = 0.6, MaxTokens = 8192 },
                        async d =>
                        {
                            reasoning.Append(d);
                            await SafeSendAsync(sse, "reasoning", new { delta = d }, ct);
                        },
                        d => sse.SendAsync("content", new { delta = d }, ct), null, ct);

                    if (string.IsNullOrEmpty(text))
                    {
                        await SafeSendAsync(sse, "error", new { message = "AI 未返回内容，请重试" }, ct);
                        return Results.Empty;
                    }
                    var parsed = ParseObject(text);
                    if (parsed is null)
                    {
                        await SafeSendAsync(sse, "error", new { message = "AI 返回格式异常，请重试" }, ct);
                        return Results.Empty;
                    }

                    var (quotes, reasons) = InterviewHistory.VerdictBasis(parsed);
                    var score = InterviewHistory.ScoreOf(parsed);
                    // 追问判定：模型说了算，但到顶/它主动收尾就不追——审问不散是硬约束
                    var willFollow = canFollow
                                     && Prop(parsed, "shouldFollow") is JsonValue sf
                                     && sf.GetValueKind() == JsonValueKind.True
                                     && StrOrNull(parsed, "question", 500) is not null;

                    var meta = new InterviewTurnMeta
                    {
                        Dimension = dimension,
                        // 写入前再过一次 SafeDepth：保证 meta.probeDepth 永远是 0|1|2|3 的合法整数。
                        // 一旦 NaN 落库（JSON 会存成 null），后续每轮都会从 0 重新开始，追问永远卡在第 1 层。
                        ProbeDepth = InterviewHistory.SafeDepth(willFollow ? depth + 1 : depth),
                        QuestionId = currentQid ?? NewQuestionId(0),
                        IsClosing = !willFollow,
                        Covered = history.Covered,
                        Target = followTarget,
                        TargetLabel = followTarget is null ? null : ResumeEditValidator.BuildFieldLabel(followTarget),
                        Verdict = dimension == InterviewDimension.Authenticity ? InterviewHistory.VerdictOf(parsed) : null,
                        Score = score,
                        Quotes = quotes.Count == 0 ? null : quotes,
                        Reasons = reasons.Count == 0 ? null : reasons,
                        Gap = StrOrNull(parsed, "gap", 200),
                        Answered = StrOrNull(parsed, "answered", 200),
                    };

                    // 追问中挖出的简历外细节 → edits 卡片，用户点「应用」才落库（绝不自动回写）
                    var (edits, _) = ResumeEditValidator.ValidateEdits(RawEdits(parsed), content, userText, userText);

                    var questionText = StrOrNull(parsed, "question", 500);
                    var judgeBody = string.Join("\n\n", new[]
                    {
                        StrOrNull(parsed, "reply", 2000),
                        questionText is null ? "" :
                            $"**{(willFollow ? $"追问 · 第 {meta.ProbeDepth} 层" : "本题结束")}**（{InterviewPrompts.DimensionLabelOf(dimension)}）：{questionText}",
                        quotes.Count == 0 ? "" : "判定依据：\n" + string.Join("\n", quotes.Select((q, i) => $"- 「{q}」—— {reasons[i]}")),
                        meta.Gap is null ? "" : $"还没答上来：{meta.Gap}",
                    }.Where(x => x is { Length: > 0 }));

                    var judgeMsg = new AiChatMessage
                    {
                        SessionId = id,
                        Role = ChatMessageRole.Assistant,
                        Content = judgeBody.Length == 0 ? "（AI 未返回文本）" : judgeBody,
                        Edits = JsonSerializer.Serialize(edits, AppDbContext.JsonOptions),
                        AppliedIndexes = JsonLiteral.EmptyArray,
                        Meta = InterviewHistory.SerializeMeta(meta),
                        Reasoning = reasoning.Length == 0 ? null : reasoning.ToString(),
                        CreatedAt = DateTime.Now,
                    };
                    db.AiChatMessages.Add(judgeMsg);
                    await db.SaveChangesAsync(ct);

                    var allEdits = new List<ResumeEdit>(edits);
                    var covered = history.Covered;
                    ChatMessageRecord? message2 = null;
                    object? planReachedInfo = null;

                    // 该收尾 → 紧接着开一道新题（见文件头「状态机」说明）
                    // 但如果已达计划题数，就不再开新题：planTotal 原本只是「计划」，从不参与终止判断，
                    // 结果是模型会无限开新题、必须靠用户手动点结束。到达计划数后交给用户决定是否继续深挖。
                    if (!willFollow)
                    {
                        var planTotal = history.Plan?.QuestionCount ?? 0;
                        var askedCount = InterviewHistory.GroupByQuestion(rows).Count; // rows 含当前题（开题消息在上一轮已落库）
                        var planReached = planTotal > 0 && askedCount >= planTotal;

                        if (planReached)
                        {
                            planReachedInfo = new { planTotal, askedCount };
                        }
                        else
                        {
                            // 当前题此刻还在 chain 里（未进 digest），换题前要把它压成摘要交给新题上下文
                            var ended = currentQid is null ? null
                                : InterviewHistory.GroupByQuestion(rows).FirstOrDefault(g => g.QuestionId == currentQid);
                            var extraDigest = ended is null
                                ? new List<string>()
                                : new List<string> { InterviewHistory.SummarizeGroup(ended) };
                            var next = await OpenNewQuestionAsync(db, chat, snapshot, sse, content, rows, history,
                                extraDigest, id, session.TargetRole, userId, session.ResumeId, ct);
                            if (next is not null)
                            {
                                message2 = next.Value.Record;
                                covered = next.Value.Covered;
                                allEdits.AddRange(next.Value.Edits);
                            }
                        }
                    }

                    session.LastMessageAt = DateTime.Now;
                    await db.SaveChangesAsync(ct);
                    await CallLog.RecordCallAsync(db, snapshot, userId, LlmCallKind.Interview, session.ResumeId, true,
                        judgeMsg.Reasoning, text);

                    await SafeSendAsync(sse, "result", new
                    {
                        message = ToRecord(judgeMsg, meta),
                        userMessage = userRecord,
                        message2,
                        edits = allEdits,
                        covered,
                        planReached = planReachedInfo,
                    }, ct);
                    await SafeSendAsync(sse, "done", new { ok = true }, ct);
                    return Results.Empty;
                }

                // ================= 分支 C：action=next，跳过当前题直接开新题 =================
                {
                    var history = InterviewHistory.Build(rows, null); // 旧题不再需要原文
                    var next = await OpenNewQuestionAsync(db, chat, snapshot, sse, content, rows, history,
                        [], id, session.TargetRole, userId, session.ResumeId, ct);
                    if (next is null)
                    {
                        await SafeSendAsync(sse, "error", new { message = "AI 未返回内容，请重试" }, ct);
                        return Results.Empty;
                    }

                    session.LastMessageAt = DateTime.Now;
                    await db.SaveChangesAsync(ct);

                    await SafeSendAsync(sse, "result", new
                    {
                        message = next.Value.Record,
                        covered = next.Value.Covered,
                    }, ct);
                    await SafeSendAsync(sse, "done", new { ok = true }, ct);
                    return Results.Empty;
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[AI-INTERVIEW] 面试回合失败: {ex}");
                await SafeSendAsync(sse, "error", new { message = "面试回合失败，请重试" }, ct);
            }
            return Results.Empty;
        });

        return app;
    }

    // -----------------------------------------------------------------------
    // 内部辅助
    // -----------------------------------------------------------------------

    private static async Task<List<InterviewRawRow>> ReadRawRowsAsync(AppDbContext db, string sessionId) =>
        await db.AiChatMessages.AsNoTracking()
            .Where(m => m.SessionId == sessionId)
            .OrderBy(m => m.CreatedAt)
            .Select(m => new InterviewRawRow(m.Id, m.Role, m.Content, m.Meta, m.CreatedAt))
            .ToListAsync();

    /// <summary>SSE result 里的消息必须是完整记录：前端直接 push 进消息流，缺 content/createdAt 会渲染成空白</summary>
    private static ChatMessageRecord ToRecord(AiChatMessage r, InterviewTurnMeta meta) => new(
        r.Id, r.SessionId, r.Role, r.Content,
        string.IsNullOrEmpty(r.Edits) ? null : JsonNode.Parse(r.Edits),
        [],
        r.Reasoning,
        ToIso(r.CreatedAt),
        JsonSerializer.SerializeToNode(meta, AppDbContext.JsonOptions));
}
