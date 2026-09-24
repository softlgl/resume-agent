// JWT 签发/校验（对齐 plugins/auth.ts：payload { userId }，7 天有效）

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace ResumeAgent.Api.Auth;

public static class JwtTokenService
{
    public const string Audience = "resume-agent";
    public const string Issuer = "resume-agent";
    public const string UserIdClaim = "userId";

    public static string Secret =>
        Environment.GetEnvironmentVariable("JWT_SECRET") ?? "change_me_to_a_long_random_secret_string";

    public static string SignToken(string userId)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var claims = new[] { new Claim(UserIdClaim, userId) };
        var token = new JwtSecurityToken(
            issuer: Issuer, audience: Audience, claims: claims,
            expires: DateTime.UtcNow.AddDays(7), signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}

public static class ClaimsPrincipalExtensions
{
    /// <summary>等价 request.userId：未登录（无 claim）返回 null</summary>
    public static string? UserId(this ClaimsPrincipal user) =>
        user.FindFirstValue(JwtTokenService.UserIdClaim);
}
