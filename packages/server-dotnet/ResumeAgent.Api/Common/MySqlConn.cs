// DATABASE_URL 兼容解析：支持 Prisma 风格 mysql://user:pass@host:3306/db 连接串，
// 也直接兼容 MySqlConnector 原生 "Server=...;Port=...;Database=..." 格式。

namespace ResumeAgent.Api.Common;

public static class MySqlConn
{
    public static string FromDatabaseUrl(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            throw new InvalidOperationException("未配置 DATABASE_URL 环境变量");
        if (!raw.StartsWith("mysql://", StringComparison.OrdinalIgnoreCase))
            return raw; // 已是原生连接串

        var uri = new Uri(raw);
        var userInfo = uri.UserInfo.Split(':', 2);
        var user = Uri.UnescapeDataString(userInfo[0]);
        var pass = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : "";
        var database = uri.AbsolutePath.TrimStart('/');
        var port = uri.Port > 0 ? uri.Port : 3306;
        return $"Server={uri.Host};Port={port};Database={database};User={user};Password={pass};" +
               "CharSet=utf8mb4;SslMode=None;AllowPublicKeyRetrieval=True;ConnectionTimeout=15";
    }
}
