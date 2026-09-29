// AI / 简历分析域专用 JSON 选项（camelCase，与前端契约一致）

using System.Text.Json;

namespace ResumeAgent.Api.Common;

public static class JsonDefaults
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };
}