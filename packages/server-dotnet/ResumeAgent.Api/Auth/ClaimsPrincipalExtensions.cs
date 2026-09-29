// 从 ClaimsPrincipal 取当前用户 id（等价 Fastify 的 request.userId）

using System.Security.Claims;

namespace ResumeAgent.Api.Auth;

public static class ClaimsPrincipalExtensions
{
    /// <summary>等价 request.userId：未登录（无 claim）返回 null</summary>
    public static string? UserId(this ClaimsPrincipal user) =>
        user.FindFirstValue(JwtTokenService.UserIdClaim);
}