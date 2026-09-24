// /resumes 模块（对齐 modules/resume.ts）：列表 / 详情 / 新建 / 更新 / 删除

using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;

namespace ResumeAgent.Api.Endpoints;

public static class ResumeEndpoints
{
    public sealed record SaveResumeRequest(string? Title = null, string? TemplateId = null, ResumeContent? Content = null);

    private static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

    public static IEndpointRouteBuilder MapResumeEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/resumes").RequireAuthorization();

        group.MapGet("/", async (ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId()!;
            var list = await db.Resumes.AsNoTracking()
                .Where(r => r.UserId == userId)
                .OrderByDescending(r => r.UpdatedAt)
                .Select(r => new { r.Id, r.Title, r.TemplateId, r.UpdatedAt })
                .ToListAsync();
            return Results.Json(new { resumes = list });
        });

        group.MapGet("/{id}", async (string id, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId()!;
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);
            return Results.Json(new { resume });
        });

        group.MapPost("/", async (SaveResumeRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId()!;
            if (string.IsNullOrWhiteSpace(body.Title) || body.Title.Length > 80 || string.IsNullOrEmpty(body.TemplateId) || body.Content is null)
                return Error("数据格式不正确", 400);
            var resume = new Resume
            {
                UserId = userId,
                Title = body.Title,
                TemplateId = body.TemplateId,
                Content = body.Content.Normalize(),
            };
            db.Resumes.Add(resume);
            await db.SaveChangesAsync();
            return Results.Json(new { resume });
        });

        group.MapPut("/{id}", async (string id, SaveResumeRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId()!;
            if (string.IsNullOrWhiteSpace(body.Title) || body.Title.Length > 80 || string.IsNullOrEmpty(body.TemplateId) || body.Content is null)
                return Error("数据格式不正确", 400);
            var resume = await db.Resumes.FirstOrDefaultAsync(r => r.Id == id && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);
            resume.Title = body.Title;
            resume.TemplateId = body.TemplateId;
            resume.Content = body.Content.Normalize();
            await db.SaveChangesAsync();
            return Results.Json(new { resume });
        });

        group.MapDelete("/{id}", async (string id, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId()!;
            var resume = await db.Resumes.FirstOrDefaultAsync(r => r.Id == id && r.UserId == userId);
            if (resume is null) return Error("简历不存在", 404);
            // 级联清理：LlmCallLog.resumeId 无外键约束，事务内手动删除调用日志
            await using var tx = await db.Database.BeginTransactionAsync();
            await db.LlmCallLogs.Where(l => l.ResumeId == id).ExecuteDeleteAsync();
            await db.Resumes.Where(r => r.Id == id).ExecuteDeleteAsync();
            await tx.CommitAsync();
            return Results.Json(new { ok = true });
        });

        return app;
    }
}
