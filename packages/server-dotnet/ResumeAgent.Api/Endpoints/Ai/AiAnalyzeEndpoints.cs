// /ai 分析模块（对齐 modules/ai/analyze.ts）：简历分析（SSE/非流式）+ 建议应用标记

using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Ai;
using ResumeAgent.Api.Services.Analysis;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Endpoints.Ai;

public static class AiAnalyzeEndpoints
{
    private static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

    public static IEndpointRouteBuilder MapAiAnalyzeEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/ai").RequireAuthorization();

        // 标记分析结果中的某条建议为「已应用」，落库到 Resume.analysis（供重开回看）
        group.MapPatch("/analyze/{resumeId}/applied", async (
            string resumeId, AnalyzeAppliedRequest body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);
            var section = body.Section;
            var index = body.Index;
            if (string.IsNullOrEmpty(section) || index is null) return Error("section 与 index 必填", 400);

            var resume = await db.Resumes.FirstOrDefaultAsync(r => r.Id == resumeId);
            if (resume is null || resume.UserId != userId) return Error("简历不存在", 404);
            var analysisJson = resume.AnalysisJson;
            if (analysisJson is null) return Error("无效的 section / index", 400);

            JsonNode? analysis;
            try { analysis = JsonNode.Parse(analysisJson); }
            catch (JsonException) { return Error("无效的 section / index", 400); }
            var sections = analysis?["sections"] as JsonObject;
            if (sections is null || !new[] { ResumeSection.Basic, ResumeSection.Works, ResumeSection.Projects, ResumeSection.Skills }.Contains(section) ||
                sections[section] is not JsonArray list ||
                index >= list.Count || list[index.Value] is not JsonObject issue)
            {
                return Error("无效的 section / index", 400);
            }
            issue["applied"] = true;
            resume.AnalysisJson = analysis!.ToJsonString();
            await db.SaveChangesAsync();
            return Results.Json(new { ok = true });
        });

        // 分析接口（streaming=true → SSE；否则 JSON）
        group.MapPost("/analyze", async (
            AnalyzeRequest body, ClaimsPrincipal principal, AppDbContext db,
            ProfileSnapshotService snapshot, Analyzer analyzer, HttpContext http,
            CancellationToken requestAborted) =>
        {
            var userId = principal.UserId();
            if (userId is null) return Error("未登录", 401);

            var streaming = body.Streaming == true;
            ResumeContent content;
            string? resumeId = null;
            if (!string.IsNullOrEmpty(body.ResumeId))
            {
                resumeId = body.ResumeId;
                var resume = await db.Resumes.AsNoTracking()
                    .FirstOrDefaultAsync(r => r.Id == resumeId && r.UserId == userId);
                if (resume is null) return Error("简历不存在", 404);
                content = resume.Content;

                // 基础分析（无 JD）：若有已存的缓存结果且未要求强制刷新 → 直接返回，不重复消耗 LLM
                var hasJd = !string.IsNullOrWhiteSpace(body.Jd);
                if (!hasJd && body.Force != true && !string.IsNullOrEmpty(resume.AnalysisJson))
                {
                    var cached = JsonSerializer.Deserialize<JsonElement>(resume.AnalysisJson);
                    if (streaming)
                    {
                        var sse = new SseWriter(http.Response);
                        await sse.InitAsync();
                        await sse.SendAsync("result", new { analysis = cached }, requestAborted);
                        await sse.SendAsync("done", new { ok = true }, requestAborted);
                        return Results.Empty;
                    }
                    return Results.Json(new { analysis = cached });
                }
            }
            else if (body.Content is not null)
            {
                content = body.Content.Normalize();
            }
            else
            {
                return Error("参数格式不正确", 400);
            }

            var cb = streaming ? new SseWriter(http.Response) : null;
            if (cb is not null) await cb.InitAsync();
            var callbacks = cb is null ? null : new Analyzer.AnalyzeCallbacks(
                OnReasoning: d => cb.SendAsync("reasoning", new { delta = d }, requestAborted),
                OnContent: d => cb.SendAsync("content", new { delta = d }, requestAborted));

            var result = await analyzer.AnalyzeAsync(content, body.Jd, callbacks, body.Config, requestAborted);
            if (result.LlmUsed) await CallLog.RecordCallAsync(db, snapshot, userId, LlmCallKind.Analyze, resumeId,
                ok: true, reasoning: result.Reasoning, output: result.Output, provider: result.LlmProvider);

            if (!string.IsNullOrWhiteSpace(body.Jd))
            {
                var match = await analyzer.JdMatchAsync(content, body.Jd.Trim(), body.Config, requestAborted);
                if (match is not null) result.Match = match;
            }

            // 基础分析结果落库，供下次打开复用（JD 匹配不落库）
            if (resumeId is not null && string.IsNullOrWhiteSpace(body.Jd))
            {
                var resume = await db.Resumes.FirstAsync(r => r.Id == resumeId);
                resume.AnalysisJson = JsonSerializer.Serialize(result, JsonDefaults.Options);
                await db.SaveChangesAsync();
            }

            if (cb is null)
                return Results.Json(new { analysis = result });

            await cb.SendAsync("result", new { analysis = JsonSerializer.SerializeToElement(result, JsonDefaults.Options) }, requestAborted);
            await cb.SendAsync("done", new { ok = true }, requestAborted);
            return Results.Empty;
        });

        return app;
    }
}