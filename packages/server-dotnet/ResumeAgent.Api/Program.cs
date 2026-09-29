// 组合根：.NET 10 + ASP.NET Core 复刻 packages/server（Fastify 版）
// 端点契约与 Node 版逐一对应，前端 packages/client 零改动。

using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Endpoints;
using ResumeAgent.Api.Services.Analysis;
using ResumeAgent.Api.Services.Export;
using ResumeAgent.Api.Services.Import;
using ResumeAgent.Api.Services.Llm;

var builder = WebApplication.CreateBuilder(args);

// ---------------- 配置：统一走配置管道（环境变量 / appsettings.json / 命令行 / 测试覆盖） ----------------
// 键名与 Node 版 .env 逐字一致，两个后端可共用同一份 .env。
// 配置在进程生命周期内不变，故启动时绑定一次并以 IOptions<T> 注入，不做热重载。
var appOptions = AppOptions.Bind(builder.Configuration);
builder.Services.AddSingleton(Options.Create(appOptions));
builder.Services.AddSingleton(Options.Create(appOptions.Llm));
builder.Services.AddSingleton(Options.Create(appOptions.Ocr));

// 端口：与 Node server 完全一致（读 PORT，默认 4000）
builder.WebHost.UseUrls($"http://0.0.0.0:{appOptions.Port}");

// ---------------- EF Core：映射现有 Prisma 库（纯消费方，不迁移） ----------------
var connStr = MySqlConnectionString.FromDatabaseUrl(appOptions.DatabaseUrl);
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseMySql(connStr, new MySqlServerVersion(new Version(8, 0, 36))));

// ---------------- JWT 认证 ----------------
// 对齐 Node 版 plugins/auth.ts：只校验签名与有效期，不校验 iss/aud
// （Node 签发的 token 不含这两个 claim，若开启校验会导致两个后端签发的 token 互不通用）
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = false,
            ValidateAudience = false,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(appOptions.JwtSecret)),
            ValidateLifetime = true,
        };
    });
builder.Services.AddSingleton<JwtTokenService>();
builder.Services.AddAuthorization();
builder.Services.AddProblemDetails();

// ---------------- LLM / AI / 导入服务 ----------------
builder.Services.AddSingleton<ProfileSnapshotService>();
builder.Services.AddSingleton<ChatService>();
builder.Services.AddSingleton<Analyzer>();
builder.Services.AddSingleton<TextExtractor>();
builder.Services.AddSingleton<OcrRunner>();
builder.Services.AddSingleton<Structurizer>();

// ---------------- CORS（对齐 @fastify/cors 配置） ----------------
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(appOptions.ClientOrigins).AllowCredentials().AllowAnyHeader().AllowAnyMethod()));

// ---------------- JSON：camelCase + 未指定时区的 DateTime 视为本地时间输出（对齐 JS 行为） ----------------
builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
    o.SerializerOptions.Converters.Add(new DateTimeLocalConverter());
});

var app = builder.Build();

app.UseExceptionHandler();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Json(new { ok = true }));

app.MapAuthEndpoints();
app.MapResumeEndpoints();
app.MapAiEndpoints();
app.MapAiChatEndpoints();
app.MapImportEndpoints();
app.MapExportEndpoints();

// 启动时从数据库加载模型配置到内存快照（对齐 aiModule 注册时的 syncProfiles）。
// 必须 await：Node 版在注册阶段已完成同步，若这里 fire-and-forget，
// 冷启动瞬间到达的 /ai/health、/ai/analyze 会读到空快照并误判为「未配置 AI 模型」。
using (var scope = app.Services.CreateScope())
{
    try
    {
        await scope.ServiceProvider.GetRequiredService<ProfileSnapshotService>().ReloadAsync();
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[LLM] 启动加载模型配置失败（数据库不可达？）: {ex.Message}");
    }
}

app.Run();
