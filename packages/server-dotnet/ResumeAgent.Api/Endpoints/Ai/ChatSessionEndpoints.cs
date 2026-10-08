// /ai/chat/sessions/*：会话列表 / 新建（可插入开场消息）/ 详情 / 历史分页 / 更新 / 删除。
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

internal static class ChatSessionEndpoints
{
    internal static void Map(RouteGroupBuilder g)
    {
        // -------------------------------------------------------------------
        // 1. 会话列表
        // -------------------------------------------------------------------
        g.MapGet("/chat/sessions", async (ClaimsPrincipal principal, AppDbContext db, HttpContext http) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var query = http.Request.Query;
            var resumeId = query["resumeId"].ToString();
            var archived = query["archived"].ToString();
            if (string.IsNullOrEmpty(resumeId)) return ApiJson.Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return ApiJson.Error("简历不存在", 404);

            var wantArchived = archived == "true";
            var sessions = await db.AiChatSessions.AsNoTracking()
                // 面试会话（Mode=interview）走 /ai/interview/*，绝不能混进对话列表。
                // 两边共用 AiChatSession 表，靠 Mode 区分——这个过滤条件漏了就会串。
                .Where(s => s.ResumeId == resumeId && s.UserId == userId && s.Archived == wantArchived
                            && s.Mode == SessionMode.Chat)
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
                sessions = sessions.Select(s => ChatProjection.SessionToMeta(
                    s, counts.GetValueOrDefault(s.Id), previews.GetValueOrDefault(s.Id))),
            });
        });

        // -------------------------------------------------------------------
        // 2. 新建会话（可选插入本地拼装的开场消息）
        // -------------------------------------------------------------------
        g.MapPost("/chat/sessions", async (CreateSessionRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var resumeId = body.ResumeId ?? "";
            if (resumeId.Length == 0) return ApiJson.Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return ApiJson.Error("简历不存在", 404);

            var focus = body.Focus ?? [];
            var title = body.Title ?? "";
            if (title.Length == 0) title = "新对话";
            var jd = (body.Jd ?? "").Trim();

            var session = new AiChatSession
            {
                ResumeId = resumeId,
                UserId = userId,
                Title = title[..Math.Min(60, title.Length)],
                Focus = focus.Count > 0 ? JsonSerializer.Serialize(focus, ChatProjection.NodeJsonOptions) : null,
                Jd = jd.Length > 0 ? jd : null,
                // 显式写明：默认值只在 DB 侧生效，面试会话（mode=interview）不能混进对话列表
                Mode = SessionMode.Chat,
                LastMessageAt = DateTime.Now,
            };
            db.AiChatSessions.Add(session);
            await db.SaveChangesAsync();

            var tasks = ChatAudit.BuildAuditTasks(ChatProjection.AnalysisNode(resume));
            var messages = new List<ChatMessageRecord>();
            string? preview = null;
            if (body.WithOpening == true)
            {
                var opening = new AiChatMessage
                {
                    SessionId = session.Id,
                    Role = ChatMessageRole.Assistant,
                    Content = ChatAudit.BuildOpeningMessage(ChatProjection.AnalysisNode(resume), tasks),
                    AppliedIndexes = JsonLiteral.EmptyArray,
                };
                db.AiChatMessages.Add(opening);
                await db.SaveChangesAsync();
                messages.Add(ChatProjection.MessageToRecord(opening));
                preview = opening.Content;
            }

            return Results.Json(new
            {
                session = ChatProjection.SessionToMeta(session, messages.Count, preview),
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
            if (userId is null) return ApiJson.Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId || session.Mode != SessionMode.Chat)
                return ApiJson.Error("对话不存在", 404);

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
                session = ChatProjection.SessionToMeta(session, count, preview),
                messages = rows.Select(ChatProjection.MessageToRecord),
                tasks = resume is null ? new List<AuditTask>() : ChatAudit.BuildAuditTasks(ChatProjection.AnalysisNode(resume)),
            });
        });

        // -------------------------------------------------------------------
        // 4. 历史消息分页（游标为消息 id）
        // -------------------------------------------------------------------
        g.MapGet("/chat/sessions/{id}/messages", async (string id, ClaimsPrincipal principal, AppDbContext db, HttpContext http) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId || session.Mode != SessionMode.Chat)
                return ApiJson.Error("对话不存在", 404);

            var query = http.Request.Query;
            var before = query["before"].ToString();
            var take = ChatProjection.ParseLimit(query["limit"].ToString(), 30, 100);

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

            return Results.Json(new { messages = rows.Select(ChatProjection.MessageToRecord) });
        });

        // -------------------------------------------------------------------
        // 5. 更新会话（标题 / 焦点 / JD / 归档）
        // -------------------------------------------------------------------
        g.MapPatch("/chat/sessions/{id}", async (string id, UpdateSessionRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var session = await db.AiChatSessions.FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId || session.Mode != SessionMode.Chat)
                return ApiJson.Error("对话不存在", 404);

            var title = body.Title ?? "";
            if (title.Trim().Length > 0)
            {
                var t = title.Trim();
                session.Title = t[..Math.Min(60, t.Length)];
            }
            if (body.Focus is not null)
            {
                var focus = body.Focus.Where(s => !string.IsNullOrEmpty(s)).ToList();
                session.Focus = focus.Count > 0 ? JsonSerializer.Serialize(focus, ChatProjection.NodeJsonOptions) : null;
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
            return Results.Json(new { session = ChatProjection.SessionToMeta(session, count, preview) });
        });

        // -------------------------------------------------------------------
        // 6. 删除会话（消息靠外键级联）
        // -------------------------------------------------------------------
        g.MapDelete("/chat/sessions/{id}", async (string id, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var session = await db.AiChatSessions.AsNoTracking().FirstOrDefaultAsync(s => s.Id == id);
            if (session is null || session.UserId != userId || session.Mode != SessionMode.Chat)
                return ApiJson.Error("对话不存在", 404);
            // 消息由 AiChatMessage_sessionId_fkey（Prisma 建表时定义，ON DELETE CASCADE）自动级联删除
            await db.AiChatSessions.Where(s => s.Id == id).ExecuteDeleteAsync();
            return Results.Json(new { ok = true });
        });
    }
}
