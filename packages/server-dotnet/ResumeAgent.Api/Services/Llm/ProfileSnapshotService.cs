// 多模型 Profile 内存快照（对齐 llm.ts 的 refreshProfiles/listProfiles/getLLMConfig）
// 持久化在数据库 AiModelProfile 表（全局共享），AI 模块在启动与每次变更后调用 ReloadAsync。
// 单例 + 锁，替代 TS 的模块级可变变量。

using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Data;

namespace ResumeAgent.Api.Services.Llm;

public class ProfileSnapshotService(IServiceScopeFactory scopeFactory, ILogger<ProfileSnapshotService> logger)
{
    private readonly object _lock = new();
    private List<LlmProfile> _profiles = [];
    private string? _activeId;
    private LlmConfig? _envConfig;
    private bool _envParsed;

    /// <summary>从数据库刷新内存快照（对齐 syncProfiles，含首启 seed 默认模型）</summary>
    public async Task ReloadAsync()
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        if (await db.AiModelProfiles.CountAsync() == 0)
        {
            var seed = GetDefaultConfig();
            db.AiModelProfiles.Add(new Data.AiModelProfile
            {
                Id = Common.Cuid.New(),
                Name = "默认模型",
                Provider = LlmDefaults.ProviderName(seed.Provider),
                ApiKey = seed.ApiKey,
                BaseUrl = seed.BaseUrl,
                Model = seed.Model,
                MaxContext = seed.MaxContext,
                MaxOutput = seed.MaxOutput,
                Active = true,
                CreatedAt = DateTime.Now,
            });
            await db.SaveChangesAsync();
        }
        var rows = await db.AiModelProfiles.AsNoTracking().OrderBy(r => r.CreatedAt).ToListAsync();
        lock (_lock)
        {
            _profiles = rows.Select(r => new LlmProfile
            {
                Id = r.Id,
                Name = r.Name,
                Provider = LlmDefaults.Parse(r.Provider) ?? LlmProvider.Openai,
                ApiKey = r.ApiKey,
                BaseUrl = r.BaseUrl,
                Model = r.Model,
                MaxContext = r.MaxContext,
                MaxOutput = r.MaxOutput,
            }).ToList();
            _activeId = rows.FirstOrDefault(r => r.Active)?.Id;
        }
        logger.LogInformation("[LLM] profiles 已刷新：{Count} 条，激活 {ActiveId}", _profiles.Count, _activeId);
    }

    public (IReadOnlyList<LlmProfile> Profiles, string? ActiveId) List()
    {
        lock (_lock) return (_profiles.ToList(), _activeId);
    }

    /// <summary>解析 .env（LLM_PROVIDER / LLM_API_KEY / LLM_BASE_URL / LLM_MODEL），惰性且缓存</summary>
    private LlmConfig? EnvConfig
    {
        get
        {
            if (_envParsed) return _envConfig;
            _envParsed = true;
            var provider = LlmDefaults.Parse(Environment.GetEnvironmentVariable("LLM_PROVIDER")) ?? LlmProvider.Deepseek;
            var apiKey = Environment.GetEnvironmentVariable("LLM_API_KEY")?.Trim();
            var def = LlmDefaults.All[provider];
            if (!LlmDefaults.IsLocal(provider) && string.IsNullOrEmpty(apiKey))
            {
                _envConfig = null;
            }
            else
            {
                _envConfig = new LlmConfig
                {
                    Provider = provider,
                    ApiKey = apiKey ?? "",
                    BaseUrl = Environment.GetEnvironmentVariable("LLM_BASE_URL")?.Trim() ?? def.BaseUrl,
                    Model = Environment.GetEnvironmentVariable("LLM_MODEL")?.Trim() ?? def.Model,
                    MaxContext = def.MaxContext,
                    MaxOutput = def.MaxOutput,
                };
            }
            return _envConfig;
        }
    }

    /// <summary>对齐 getLLMConfig：runtimeOverride（单次请求覆盖）> 激活 profile > .env</summary>
    public LlmConfig? GetConfig(LlmConfig? runtimeOverride = null)
    {
        if (runtimeOverride is not null)
        {
            var baseEnv = EnvConfig;
            var merged = new LlmConfig
            {
                Provider = runtimeOverride.Provider,
                ApiKey = !string.IsNullOrEmpty(runtimeOverride.ApiKey) ? runtimeOverride.ApiKey : baseEnv?.ApiKey ?? "",
                BaseUrl = runtimeOverride.BaseUrl,
                Model = runtimeOverride.Model,
                MaxContext = runtimeOverride.MaxContext,
                MaxOutput = runtimeOverride.MaxOutput,
            };
            var cfg = LlmDefaults.MergeAndValidate(merged);
            if (cfg is not null) return cfg;
        }
        lock (_lock)
        {
            var active = _profiles.FirstOrDefault(p => p.Id == _activeId);
            if (active is not null) return LlmDefaults.MergeAndValidate(active);
        }
        return EnvConfig is null ? null : LlmDefaults.MergeAndValidate(EnvConfig);
    }

    /// <summary>对齐 getDefaultConfig：给前端展示"当前生效"配置；无配置时返回 ollama 预设兜底</summary>
    public LlmConfig GetDefaultConfig()
    {
        var cfg = GetConfig();
        if (cfg is not null) return cfg;
        var d = LlmDefaults.All[LlmProvider.Ollama];
        return new LlmConfig
        {
            Provider = LlmProvider.Ollama, ApiKey = "", BaseUrl = d.BaseUrl, Model = d.Model,
            MaxContext = d.MaxContext, MaxOutput = d.MaxOutput,
        };
    }

    public bool IsAvailable(LlmConfig? runtimeOverride = null) => GetConfig(runtimeOverride) is not null;

    /// <summary>对齐 defaultsFor：provider 默认 baseUrl / model，供持久化前兜底</summary>
    public static (string BaseUrl, string Model, int MaxContext, int MaxOutput) DefaultsFor(LlmProvider p) =>
        LlmDefaults.All[p];
}
