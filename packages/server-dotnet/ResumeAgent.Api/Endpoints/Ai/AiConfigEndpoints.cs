// /ai 配置模块（对齐 modules/ai/config.ts）：模型 profile 配置管理、健康检查、最近一次调用日志

using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Endpoints.Ai;

public static class AiConfigEndpoints
{
    private static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

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
        thinkingMode = LlmThinking.Normalize(p.ThinkingMode),
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

    public static IEndpointRouteBuilder MapAiConfigEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/ai").RequireAuthorization();

        // 最近一次 AI 调用日志（供前端展示，数据保留全量历史）
        group.MapGet("/calls/latest", async (ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId()!;
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
        group.MapPost("/config", async (AiConfigRequest body, ClaimsPrincipal principal, AppDbContext db, ProfileSnapshotService snapshot) =>
        {
            if (principal.UserId() is null) return Error("未登录", 401);
            var action = body.Action ?? "add";

            switch (action)
            {
                case "add":
                {
                    var providerName = body.Provider;
                    var provider = LlmDefaults.Parse(providerName);
                    if (provider is null) return Error("provider 必填", 400);
                    var def = ProfileSnapshotService.DefaultsFor(provider.Value);
                    var count = await db.AiModelProfiles.CountAsync();
                    var model = body.Model?.Trim();
                    db.AiModelProfiles.Add(new Data.AiModelProfile
                    {
                        Id = Cuid.New(),
                        Name = body.Name?.Trim()
                            ?? (model is { Length: > 0 } ? $"{providerName} · {model}" : providerName!),
                        Provider = LlmDefaults.ProviderName(provider.Value),
                        ApiKey = body.ApiKey ?? "",
                        BaseUrl = body.BaseUrl?.Trim() ?? def.BaseUrl,
                        Model = model is { Length: > 0 } ? model : def.Model,
                        MaxContext = body.MaxContext ?? def.MaxContext,
                        MaxOutput = body.MaxOutput ?? def.MaxOutput,
                        ThinkingMode = LlmThinking.Normalize(body.ThinkingMode),
                        Active = count == 0, // 第一条自动激活
                        CreatedAt = DateTime.Now,
                    });
                    break;
                }
                case "update":
                {
                    if (body.Id is null) return Error("id 必填", 400);
                    var t = await db.AiModelProfiles.FirstOrDefaultAsync(x => x.Id == body.Id);
                    if (t is null) return Error("模型不存在", 404);
                    var provider = LlmDefaults.Parse(body.Provider) ?? LlmDefaults.Parse(t.Provider) ?? LlmProvider.Openai;
                    var model = body.Model?.Trim();
                    t.Name = body.Name?.Trim() ?? t.Name;
                    t.Provider = LlmDefaults.ProviderName(provider);
                    // 这几个字段「传了才覆盖」，没传保持原值
                    if (body.ApiKey is not null) t.ApiKey = body.ApiKey;
                    if (body.BaseUrl is not null) t.BaseUrl = body.BaseUrl.Trim();
                    t.Model = model is { Length: > 0 } ? model : t.Model;
                    if (body.MaxContext is not null) t.MaxContext = body.MaxContext.Value;
                    if (body.MaxOutput is not null) t.MaxOutput = body.MaxOutput.Value;
                    if (body.ThinkingMode is not null) t.ThinkingMode = LlmThinking.Normalize(body.ThinkingMode);
                    break;
                }
                case "remove":
                {
                    if (body.Id is null) return Error("id 必填", 400);
                    var t = await db.AiModelProfiles.FirstOrDefaultAsync(x => x.Id == body.Id);
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
                    if (body.Id is null) return Error("id 必填", 400);
                    var t = await db.AiModelProfiles.FirstOrDefaultAsync(x => x.Id == body.Id);
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
            if (principal.UserId() is null) return Error("未登录", 401);
            await db.AiModelProfiles.ExecuteDeleteAsync();
            await snapshot.ReloadAsync();
            return Results.Json(ConfigPayload(snapshot));
        });

        return app;
    }
}