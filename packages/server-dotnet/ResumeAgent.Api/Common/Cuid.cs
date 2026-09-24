// cuid 风格 id 生成器：与 Prisma 的 cuid() 输出保持同族格式（c + 时间戳 base36 + 随机 base36，共 25 字符），
// 保证 .NET 服务写入的记录与 Node 服务写入的记录在数据层风格一致。

using System.Security.Cryptography;

namespace ResumeAgent.Api.Common;

public static class Cuid
{
    private static long _lastTime = -1;
    private static readonly object Lock = new();

    public static string New()
    {
        long time;
        byte[] rand;
        lock (Lock)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (now <= _lastTime) now = _lastTime + 1;
            _lastTime = now;
            time = now;
            rand = RandomNumberGenerator.GetBytes(11);
        }
        var ts = ToBase36(time).PadLeft(10, '0');
        var sb = new System.Text.StringBuilder("c").Append(ts);
        foreach (var b in rand) sb.Append(ToBase36(b & 63).PadLeft(2, '0')[..2]);
        return sb.ToString()[..25];
    }

    private static string ToBase36(long value)
    {
        const string alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
        if (value == 0) return "0";
        var sb = new System.Text.StringBuilder();
        while (value > 0)
        {
            sb.Insert(0, alphabet[(int)(value % 36)]);
            value /= 36;
        }
        return sb.ToString();
    }
}
