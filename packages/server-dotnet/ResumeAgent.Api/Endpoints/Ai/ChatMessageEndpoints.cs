// /ai/chat 发消息（SSE 流式）/ 标记建议卡片已应用 / 权威校验 edits，
// 以及「发给 LLM 的用户消息」拼装（简历 JSON + @引用 + 焦点 + 待办 + JD）。
// 由 AiChatEndpoints.MapAiChatEndpoints 统一挂载，不要单独注册。

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

internal static class ChatMessageEndpoints
{
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
                value = item is null ? "null" : item.ToJsonString(ChatProjection.PrettyJsonOptions);
            }
            else
            {
                var node = rawContent?[parsed.Section];
                value = node is null ? "null" : node.ToJsonString(ChatProjection.PrettyJsonOptions);
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
        var pretty = sanitized.ToJsonString(ChatProjection.PrettyJsonOptions);
        var json = pretty.Length <= budget ? pretty : CompactResume(sanitized).ToJsonString(ChatProjection.PrettyJsonOptions);

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
    internal static void Map(RouteGroupBuilder g)
    {
        // -------------------------------------------------------------------
        // 7. 发消息（SSE 流式）
        // -------------------------------------------------------------------
        g.MapPost("/chat/sessions/{id}/messages", async (
            string id, SendMessageRequest body, ClaimsPrincipal principal, AppDbContext db,
            ProfileSnapshotService snapshot, ChatService chat, HttpContext http, CancellationToken ct) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var userText = (body.Content ?? "").Trim();
            if (userText.Length == 0) return ApiJson.Error("消息内容不能为空", 400);

            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId || session.Mode != SessionMode.Chat)
                return ApiJson.Error("对话不存在", 404);

            var resume = await db.Resumes.AsNoTracking()
                .FirstOrDefaultAsync(r => r.Id == session.ResumeId && r.UserId == userId);
            if (resume is null) return ApiJson.Error("简历不存在", 404);

            if (!snapshot.IsAvailable()) return ApiJson.Error("未配置 AI 模型，无法对话", 400);

            var content = resume.Content;
            var rawContent = JsonSerializer.SerializeToNode(content, ChatProjection.NodeJsonOptions)!;
            var focus = ChatProjection.ParseFocus(session.Focus);
            var tasks = ChatAudit.BuildAuditTasks(ChatProjection.AnalysisNode(resume));

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
                var messages = new List<ChatMessageItem> { new(ChatMessageRole.System, ChatPrompts.ChatSystemPrompt) };
                messages.AddRange(History.GetHistoryForLLM(history, budget));
                messages.Add(new ChatMessageItem(ChatMessageRole.User, BuildChatUserContent(
                    rawContent, focus, tasks, session.Jd, userText, ExtractRefs(userText, content, rawContent), snapshot)));

                var text = await chat.ChatStreamAsync(
                    messages,
                    new ChatOptionsEx { JsonSchema = ChatPrompts.ChatSchema, Temperature = 0.4, MaxTokens = 262144 },
                    async d =>
                    {
                        reasoningTxt.Append(d);
                        await sse.SendAsync("reasoning", new { delta = d }, ct);
                    },
                    d => sse.SendAsync("content", new { delta = d }, ct),
                    null, ct);

                if (string.IsNullOrEmpty(text))
                {
                    await sse.TrySendAsync( "error", new { message = "AI 未返回内容，请重试或检查模型配置" }, ct);
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
                    await sse.TrySendAsync( "error", new { message = "AI 返回格式异常，请重试" }, ct);
                    return Results.Empty;
                }
                if (parsed.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
                {
                    await sse.TrySendAsync( "error", new { message = "AI 返回格式异常，请重试" }, ct);
                    return Results.Empty;
                }

                var rawEdits = parsed.ValueKind == JsonValueKind.Object && parsed.TryGetProperty("edits", out var e)
                    ? e
                    : default;
                var (edits, rejected) = ResumeEditValidator.ValidateEdits(rawEdits, content, userText, userConvoText);

                var replyText = parsed.ValueKind == JsonValueKind.Object ? ChatProjection.GetStringProperty(parsed, "reply").Trim() : "";
                var llmAsks = parsed.ValueKind == JsonValueKind.Object ? ChatProjection.GetStringArray(parsed, "asks") : [];

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

                await sse.SendAsync("result", new { message = ChatProjection.MessageToRecord(assistant), edits, rejected }, ct);
                await sse.SendAsync("done", new { ok = true }, ct);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[AI-CHAT] 对话失败: {ex.Message}");
                await sse.TrySendAsync( "error", new { message = "对话失败，请重试" }, ct);
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
            if (userId is null) return ApiJson.Error("未登录", 401);
            if (!int.TryParse(index, out var idx) || idx < 0) return ApiJson.Error("index 不合法", 400);

            var msg = await db.AiChatMessages.FirstOrDefaultAsync(m => m.Id == id);
            if (msg is null) return ApiJson.Error("消息不存在", 404);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == msg.SessionId);
            if (session is null || session.UserId != userId) return ApiJson.Error("消息不存在", 404);

            var current = ChatProjection.ParseAppliedIndexes(msg.AppliedIndexes);
            // 只有显式 applied=false 才是「取消应用」，其余（缺省/null）都按「已应用」处理
            var applied = body.Applied != false;
            var next = applied
                ? current.Append(idx).Distinct().OrderBy(x => x).ToList()
                : current.Where(x => x != idx).ToList();

            msg.AppliedIndexes = JsonSerializer.Serialize(next, ChatProjection.NodeJsonOptions);
            await db.SaveChangesAsync();
            return Results.Json(new { ok = true, message = ChatProjection.MessageToRecord(msg) });
        });

        // -------------------------------------------------------------------
        // 9. 权威校验 edits（卡片表单补空后 / 批量应用前调用）
        // -------------------------------------------------------------------
        g.MapPost("/chat/validate-edits", async (ValidateEditsRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var resumeId = body.ResumeId ?? "";
            if (resumeId.Length == 0) return ApiJson.Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return ApiJson.Error("简历不存在", 404);

            var content = resume.Content;
            var (edits, rejected) = ResumeEditValidator.ValidateEdits(
                ChatProjection.ToJsonElement(body.Edits), content, body.UserText ?? "");
            // 补充 append 必填项提示，供卡片表单使用
            var missing = edits
                .Select(e => e.Op == EditOp.Append && e.Section != ResumeSection.Basic
                    ? ResumeEditValidator.CheckAppendRequired(e.Section, e.Item ?? new ResumeEditItem())
                    : new List<string>())
                .ToList();
            return Results.Json(new { edits, rejected, missing });
        });
    }
}
