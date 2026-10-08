// /auth 模块（对齐 modules/auth.ts）：注册 / 登录 / 当前用户

using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Data;

namespace ResumeAgent.Api.Endpoints;

public static class AuthEndpoints
{
    public sealed record AuthRequest(string? Username = null, string? Password = null);

    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/auth");

        group.MapPost("/register", async (AuthRequest body, AppDbContext db, JwtTokenService jwt) =>
        {
            var username = body.Username?.Trim() ?? "";
            var password = body.Password ?? "";
            if (!RequestValidation.IsValidCredentials(username, password))
                return ApiJson.Error("用户名 3-32 位，密码 6-64 位", 400);
            if (await db.Users.AnyAsync(u => u.Username == username))
                return ApiJson.Error("用户名已存在", 409);
            var user = new User { Username = username, Password = BCrypt.Net.BCrypt.HashPassword(password, 10) };
            db.Users.Add(user);
            await db.SaveChangesAsync();
            return Results.Json(new { token = jwt.SignToken(user.Id), username });
        });

        group.MapPost("/login", async (AuthRequest body, AppDbContext db, JwtTokenService jwt) =>
        {
            var username = body.Username?.Trim() ?? "";
            var password = body.Password ?? "";
            if (!RequestValidation.IsValidCredentials(username, password))
                return ApiJson.Error("用户名或密码格式不正确", 400);
            var user = await db.Users.FirstOrDefaultAsync(u => u.Username == username);
            if (user is null || !BCrypt.Net.BCrypt.Verify(password, user.Password))
                return ApiJson.Error("用户名或密码错误", 401);
            return Results.Json(new { token = jwt.SignToken(user.Id), username = user.Username });
        });

        group.MapGet("/me", async (ClaimsPrincipal principal, AppDbContext db) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);
            var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId);
            if (user is null) return ApiJson.Error("未登录", 401);
            return Results.Json(new { username = user.Username });
        }).RequireAuthorization();

        return app;
    }
}
