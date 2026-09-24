// /ai 模块（对齐 modules/ai.ts）：配置管理、分析（SSE/非流式）、调用日志、建议应用标记

using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Analysis;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Endpoints;

public static class AiEndpoints
{
    public sealed record AnalyzeRequest(
        string? ResumeId = null, ResumeContent? Content = null, string? Jd = null,
        bool? Force = null, bool? Streaming = null, LlmConfig? Config = null);

    private static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

    private static string? UserIdOf(ClaimsPrincipal p) => p.UserId();

    private static string MaskApiKey(string key)
    {
        if (string.IsNullOrEmpty(key)) return "";
        return key.Length <= 8
            ? $"{key[..2]}***{key[^2..]}"
            : $"{key[..4]}***{key[^4..]}";
    }

    private static object ProfilePayload(LlmProfile p, string? activeId) => new
    {
        p.Id, p.Name,
        provider = LlmDefaults.ProviderName(p.Provider),
        p.BaseUrl, p.Model, p.MaxContext, p.MaxOutput,
        apiKeyMasked = MaskApiKey(p.ApiKey),
        active = p.Id == activeId,
    };

    private static object ConfigPayload(ProfileSnapshotService snapshot)
    {
        var (list, activeId) = snapshot.List();
        var cfg = snapshot.GetDefaultConfig();
        return new
        {
            profiles = list.Select(p => ProfilePayload(p, activeId)),
            activeId,
            config = new
            {
                provider = LlmDefaults.ProviderName(cfg.Provider),
                cfg.BaseUrl, cfg.Model,
                apiKeyMasked = MaskApiKey(cfg.ApiKey),
            },
            available = snapshot.IsAvailable(),
        };
    }

    /// <summary>记录一次 AI 调用日志（保留全部历史，前端只展示最新一条）</summary>
    private static async Task RecordCallAsync(AppDbContext db, ProfileSnapshotService snapshot, string userId, ResumeAnalysis result, string kind, string? resumeId)
    {
        try
        {
            var cfg = snapshot.GetDefaultConfig();
            db.LlmCallLogs.Add(new LlmCallLog
            {
                Id = Cuid.New(),
                UserId = userId,
                Kind = kind,
                ResumeId = resumeId,
                Provider = result.LlmProvider ?? LlmDefaults.ProviderName(cfg.Provider),
                Model = cfg.Model,
                Ok = true,
                Reasoning = result.Reasoning,
                Output = result.Output,
                CreatedAt = DateTime.Now,
            });
            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[AI] 记录调用日志失败: {ex.Message}");
        }
    }

    public static IEndpointRouteBuilder MapAiEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/ai").RequireAuthorization();

        // 最近一次 AI 调用日志（供前端展示，数据保留全量历史）
        group.MapGet("/calls/latest", async (ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = UserIdOf(principal)!;
            var row = await db.LlmCallLogs.AsNoTracking()
                .Where(l => l.UserId == userId)
                .OrderByDescending(l => l.CreatedAt)
                .FirstOrDefaultAsync();
            if (row is null) return Results.Json(new { call = (object?)null });
            return Results.Json(new
            {
                call = new
                {
                    row.Id, row.Kind, row.ResumeId, row.Provider, row.Model, row.Ok,
                    row.Reasoning, row.Output, createdAt = row.CreatedAt,
                },
            });
        });

        // 健康检查
        group.MapGet("/health", (ProfileSnapshotService snapshot) => Results.Json(new
        {
            llmAvailable = snapshot.IsAvailable(),
            config = snapshot.GetDefaultConfig(),
        }));

        // 获取配置列表（模型 profiles + 当前激活）+ 当前生效配置摘要
        group.MapGet("/config", async (ProfileSnapshotService snapshot) =>
        {
            await snapshot.ReloadAsync();
            return Results.Json(ConfigPayload(snapshot));
        });

        // 增删改选模型 profile：body { action: 'add'|'update'|'remove'|'setActive'|'clear', ... }
        group.MapPost("/config", async (JsonObject body, ClaimsPrincipal principal, AppDbContext db, ProfileSnapshotService snapshot) =>
        {
            if (UserIdOf(principal) is null) return Error("未登录", 401);
            var action = body?["action"]?.GetValue<string>() ?? "add";
            string? Id() => body?["id"]?.GetValue<string>();

            switch (action)
            {
                case "add":
                {
                    var providerName = body?["provider"]?.GetValue<string>();
                    var provider = LlmDefaults.Parse(providerName);
                    if (provider is null) return Error("provider 必填", 400);
                    var def = ProfileSnapshotService.DefaultsFor(provider.Value);
                    var count = await db.AiModelProfiles.CountAsync();
                    var model = body?["model"]?.GetValue<string>()?.Trim();
                    db.AiModelProfiles.Add(new Data.AiModelProfile
                    {
                        Id = Cuid.New(),
                        Name = body?["name"]?.GetValue<string>()?.Trim()
                            ?? (model is { Length: > 0 } ? $"{providerName} · {model}" : providerName!),
                        Provider = LlmDefaults.ProviderName(provider.Value),
                        ApiKey = body?["apiKey"]?.GetValue<string>() ?? "",
                        BaseUrl = body?["baseUrl"]?.GetValue<string>()?.Trim() ?? def.BaseUrl,
                        Model = model is { Length: > 0 } ? model : def.Model,
                        MaxContext = body?["maxContext"]?.GetValue<int>() ?? def.MaxContext,
                        MaxOutput = body?["maxOutput"]?.GetValue<int>() ?? def.MaxOutput,
                        Active = count == 0, // 第一条自动激活
                        CreatedAt = DateTime.Now,
                    });
                    break;
                }
                case "update":
                {
                    var id = Id();
                    if (id is null) return Error("id 必填", 400);
                    var t = await db.AiModelProfiles.FirstOrDefaultAsync(x => x.Id == id);
                    if (t is null) return Error("模型不存在", 404);
                    var provider = LlmDefaults.Parse(body?["provider"]?.GetValue<string>()) ?? LlmDefaults.Parse(t.Provider) ?? LlmProvider.Openai;
                    var def = ProfileSnapshotService.DefaultsFor(provider);
                    var model = body?["model"]?.GetValue<string>()?.Trim();
                    t.Name = body?["name"]?.GetValue<string>()?.Trim() ?? t.Name;
                    t.Provider = LlmDefaults.ProviderName(provider);
                    if (body?["apiKey"] is not null) t.ApiKey = body["apiKey"]!.GetValue<string>();
                    if (body?["baseUrl"] is not null) t.BaseUrl = body["baseUrl"]!.GetValue<string>()?.Trim() ?? def.BaseUrl;
                    t.Model = model is { Length: > 0 } ? model : t.Model;
                    if (body?["maxContext"] is not null) t.MaxContext = body["maxContext"]!.GetValue<int>();
                    if (body?["maxOutput"] is not null) t.MaxOutput = body["maxOutput"]!.GetValue<int>();
                    break;
                }
                case "remove":
                {
                    var id = Id();
                    if (id is null) return Error("id 必填", 400);
                    var t = await db.AiModelProfiles.FirstOrDefaultAsync(x => x.Id == id);
                    if (t is null) return Error("模型不存在", 404);
                    db.AiModelProfiles.Remove(t);
                    await db.SaveChangesAsync();
                    // 删除激活项时让第一条成为新的激活
                    if (t.Active)
                    {
                        var next = await db.AiModelProfiles.OrderBy(x => x.CreatedAt).FirstOrDefaultAsync();
                        if (next is not null) next.Active = true;
                    }
                    break;
                }
                case "setActive":
                {
                    var id = Id();
                    if (id is null) return Error("id 必填", 400);
                    var t = await db.AiModelProfiles.FirstOrDefaultAsync(x => x.Id == id);
                    if (t is null) return Error("模型不存在", 404);
                    await db.AiModelProfiles.Where(x => x.Active).ExecuteUpdateAsync(s => s.SetProperty(x => x.Active, false));
                    t.Active = true;
                    break;
                }
                case "clear":
                    await db.AiModelProfiles.ExecuteDeleteAsync();
                    break;
                default:
                    return Error($"未知 action: {action}", 400);
            }
            await db.SaveChangesAsync();
            await snapshot.ReloadAsync();
            return Results.Json(ConfigPayload(snapshot));
        });

        // 清空所有模型 profile（回到 .env 逻辑）
        group.MapDelete("/config", async (ClaimsPrincipal principal, AppDbContext db, ProfileSnapshotService snapshot) =>
        {
            if (UserIdOf(principal) is null) return Error("未登录", 401);
            await db.AiModelProfiles.ExecuteDeleteAsync();
            await snapshot.ReloadAsync();
            return Results.Json(ConfigPayload(snapshot));
        });

        // 标记分析结果中的某条建议为「已应用」，落库到 Resume.analysis（供重开回看）
        group.MapPatch("/analyze/{resumeId}/applied", async (
            string resumeId, JsonObject body, ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = UserIdOf(principal);
            if (userId is null) return Error("未登录", 401);
            var section = body?["section"]?.GetValue<string>();
            var index = body?["index"] is JsonValue iv && iv.TryGetValue<int>(out var i) ? i : (int?)null;
            if (string.IsNullOrEmpty(section) || index is null) return Error("section 与 index 必填", 400);

            var resume = await db.Resumes.FirstOrDefaultAsync(r => r.Id == resumeId);
            if (resume is null || resume.UserId != userId) return Error("简历不存在", 404);
            var analysisJson = resume.AnalysisJson;
            if (analysisJson is null) return Error("无效的 section / index", 400);

            JsonNode? analysis;
            try { analysis = JsonNode.Parse(analysisJson); }
            catch (JsonException) { return Error("无效的 section / index", 400); }
            var sections = analysis?["sections"] as JsonObject;
            if (sections is null || !new[] { "basic", "works", "projects", "skills" }.Contains(section) ||
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
            var userId = UserIdOf(principal);
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
                OnReasoning: d => cb.SendAsync("reasoning", new { delta = d }, requestAborted).GetAwaiter().GetResult(),
                OnContent: d => cb.SendAsync("content", new { delta = d }, requestAborted).GetAwaiter().GetResult());

            var result = await analyzer.AnalyzeAsync(content, body.Jd, callbacks, body.Config, requestAborted);
            if (result.LlmUsed) await RecordCallAsync(db, snapshot, userId, result, "analyze", resumeId);

            if (!string.IsNullOrWhiteSpace(body.Jd))
            {
                var match = await analyzer.JdMatchAsync(content, body.Jd.Trim(), body.Config, requestAborted);
                if (match is not null) result.Match = match;
            }

            // 基础分析结果落库，供下次打开复用（JD 匹配不落库）
            if (resumeId is not null && string.IsNullOrWhiteSpace(body.Jd))
            {
                var resume = await db.Resumes.FirstAsync(r => r.Id == resumeId);
                resume.AnalysisJson = JsonSerializer.Serialize(result, AppJson.Options);
                await db.SaveChangesAsync();
            }

            if (cb is null)
                return Results.Json(new { analysis = result });

            await cb.SendAsync("result", new { analysis = JsonSerializer.SerializeToElement(result, AppJson.Options) }, requestAborted);
            await cb.SendAsync("done", new { ok = true }, requestAborted);
            return Results.Empty;
        });

        return app;
    }
}
