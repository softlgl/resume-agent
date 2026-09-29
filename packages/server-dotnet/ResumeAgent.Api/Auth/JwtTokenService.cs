// JWT 签发/校验（对齐 plugins/auth.ts：payload 只有 { userId, exp }，7 天有效，不写 iss/aud）

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;
using ResumeAgent.Api.Common;

namespace ResumeAgent.Api.Auth;

public sealed class JwtTokenService(IOptions<AppOptions> options)
{
    public const string UserIdClaim = "userId";

    public string Secret => options.Value.JwtSecret;

    public string SignToken(string userId)
    {
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        // 不传 issuer/audience：与 Node 版 jsonwebtoken 的 payload 保持逐字一致（仅 userId + exp），
        // 两个后端共用同一密钥，互相签发的 token 都能被对方接受
        var claims = new[] { new Claim(UserIdClaim, userId) };
        var token = new JwtSecurityToken(
            claims: claims,
            expires: DateTime.UtcNow.AddDays(7), signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}