// 组合根：.NET 10 + ASP.NET Core 复刻 packages/server（Fastify 版）
// 端点契约与 Node 版逐一对应，前端 packages/client 零改动。

using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
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

// 端口：与 Node server 完全一致（读 PORT，默认 4000）
var port = Environment.GetEnvironmentVariable("PORT") ?? "4000";
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

// ---------------- EF Core：映射现有 Prisma 库（纯消费方，不迁移） ----------------
var connStr = MySqlConn.FromDatabaseUrl(Environment.GetEnvironmentVariable("DATABASE_URL"));
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseMySql(connStr, new MySqlServerVersion(new Version(8, 0, 36))));

// ---------------- JWT 认证 ----------------
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = JwtTokenService.Issuer,
            ValidateAudience = true,
            ValidAudience = JwtTokenService.Audience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(JwtTokenService.Secret)),
            ValidateLifetime = true,
        };
    });
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
var origins = (Environment.GetEnvironmentVariable("CLIENT_ORIGIN") ?? "http://localhost:5173")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(origins).AllowCredentials().AllowAnyHeader().AllowAnyMethod()));

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
app.MapImportEndpoints();
app.MapExportEndpoints();

// 启动时从数据库加载模型配置到内存快照（对齐 aiModule 注册时的 syncProfiles）
Task.Run(async () =>
{
    using var scope = app.Services.CreateScope();
    try
    {
        await scope.ServiceProvider.GetRequiredService<ProfileSnapshotService>().ReloadAsync();
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[LLM] 启动加载模型配置失败（数据库不可达？）: {ex.Message}");
    }
});

app.Run();

/// <summary>MySQL 返回的 DateTime 无时区标记；序列化时按本地时间输出带时区的 ISO 8601（等价 JS toISOString 观感）</summary>
public class DateTimeLocalConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTime();

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options)
    {
        if (value.Kind == DateTimeKind.Unspecified) value = DateTime.SpecifyKind(value, DateTimeKind.Local);
        writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"));
    }
}
