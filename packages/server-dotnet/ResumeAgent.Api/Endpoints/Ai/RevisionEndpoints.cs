// /ai/revisions：修订账本列表 / 记一笔 / 标记撤销。
// 简历内容的回写由前端完成，服务端只当账本。
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

internal static class RevisionEndpoints
{
    internal static void Map(RouteGroupBuilder g)
    {
        // -------------------------------------------------------------------
        // 10. 修订账本列表
        // -------------------------------------------------------------------
        g.MapGet("/revisions", async (ClaimsPrincipal principal, AppDbContext db, HttpContext http) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var query = http.Request.Query;
            var resumeId = query["resumeId"].ToString();
            var before = query["before"].ToString();
            if (string.IsNullOrEmpty(resumeId)) return ApiJson.Error("resumeId 必填", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return ApiJson.Error("简历不存在", 404);

            var take = ChatProjection.ParseLimit(query["limit"].ToString(), 50, 200);

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
                revisions = rows.Select(ChatProjection.RevisionPayload),
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
            if (userId is null) return ApiJson.Error("未登录", 401);
            var resumeId = body.ResumeId ?? "";
            var op = body.Op ?? "";
            var section = body.Section ?? "";
            if (resumeId.Length == 0) return ApiJson.Error("resumeId 必填", 400);
            if (op != EditOp.Set && op != EditOp.Append) return ApiJson.Error("op 不合法", 400);
            if (section.Length == 0 || !ResumeEditValidator.SettableFields.ContainsKey(section))
                return ApiJson.Error("section 不合法", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
            if (resume is null) return ApiJson.Error("简历不存在", 404);

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
            return Results.Json(new { revision = ChatProjection.RevisionPayload(revision) });
        });

        // -------------------------------------------------------------------
        // 12. 标记已撤销（简历回写由前端完成，服务端只当账本）
        // -------------------------------------------------------------------
        g.MapPatch("/revisions/{id}", async (string id, UpdateRevisionRequest? body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var row = await db.AiRevisions.FirstOrDefaultAsync(r => r.Id == id);
            if (row is null || row.UserId != userId) return ApiJson.Error("记录不存在", 404);

            // reverted=false 表示取消撤销；不带 body（前端即如此调用）或不传该字段都按「标记已撤销」处理
            row.RevertedAt = body?.Reverted == false ? null : DateTime.Now;
            await db.SaveChangesAsync();
            return Results.Json(new { revision = ChatProjection.RevisionPayload(row) });
        });
    }
}
