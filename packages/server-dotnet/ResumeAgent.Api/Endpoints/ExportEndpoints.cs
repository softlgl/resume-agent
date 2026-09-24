// /export 模块（对齐 modules/export.ts）：POST 携带分页断点为主，GET 兼容无断点场景

using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Export;

namespace ResumeAgent.Api.Endpoints;

public static class ExportEndpoints
{
    public sealed record ExportRequest(string[]? PageBreakIds = null);

    private static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

    public static IEndpointRouteBuilder MapExportEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/export").RequireAuthorization();

        async Task<IResult> Handler(
            string id, string format, HttpRequest request, HttpResponse response,
            ClaimsPrincipal principal, AppDbContext db, CancellationToken ct)
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            if (format is not ("docx" or "pdf")) return Error("不支持的格式", 400);
            var resume = await db.Resumes.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id && r.UserId == userId, ct);
            if (resume is null) return Error("简历不存在", 404);

            var content = resume.Content.Normalize();
            var safeName = System.Text.RegularExpressions.Regex.Replace(resume.Title ?? "resume", @"[\\/:*?""<>|]", "_");
            var asciiName = System.Text.RegularExpressions.Regex.IsMatch(safeName, @"^[A-Za-z0-9_\-.]+$")
                ? $"{safeName}.{format}"
                : $"resume.{format}";
            var encodedName = Uri.EscapeDataString($"{safeName}.{format}");
            var disposition = $"attachment; filename=\"{asciiName}\"; filename*=UTF-8''{encodedName}";

            // 预览上报的分页断点（块 id 列表）：导出端在这些块前插入硬分页，实现逐页一致。
            // GET（无 body，如旧链接）降级为空断点，仍走导出器自身的自动分页。
            var pageBreakIds = Array.Empty<string>();
            if (HttpMethods.IsPost(request.Method))
            {
                try
                {
                    request.EnableBuffering();
                    var doc = await System.Text.Json.JsonSerializer.DeserializeAsync<ExportRequest>(
                        request.Body, SseWriter.JsonOpts, ct);
                    if (doc?.PageBreakIds is { Length: > 0 }) pageBreakIds = doc.PageBreakIds;
                }
                catch
                {
                    // body 解析失败按无断点处理
                }
            }

            byte[] buf;
            if (format == "docx")
            {
                buf = DocxRenderer.Render(content, resume.TemplateId, pageBreakIds);
                response.ContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            }
            else
            {
                buf = PdfRenderer.Render(content, resume.TemplateId, pageBreakIds);
                response.ContentType = "application/pdf";
            }
            response.Headers["Content-Disposition"] = disposition;
            await response.Body.WriteAsync(buf, ct);
            return Results.Empty;
        }

        group.MapPost("/{id}/{format}", (string id, string format, HttpRequest req, HttpResponse res,
            ClaimsPrincipal p, AppDbContext db, CancellationToken ct) => Handler(id, format, req, res, p, db, ct));
        group.MapGet("/{id}/{format}", (string id, string format, HttpRequest req, HttpResponse res,
            ClaimsPrincipal p, AppDbContext db, CancellationToken ct) => Handler(id, format, req, res, p, db, ct));

        return app;
    }
}
