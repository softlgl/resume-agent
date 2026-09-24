// SSE 输出（对齐 TS 版手写的 `event: x\ndata: y\n\n` 帧格式，前端解析逻辑零改动）

using System.Text;
using System.Text.Json;

namespace ResumeAgent.Api.Endpoints;

public class SseWriter(HttpResponse? response)
{
    public static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
    };

    public async Task InitAsync()
    {
        if (response is null) return;
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        response.Headers["Connection"] = "keep-alive";
        // 禁用响应缓冲，保证 reasoning/content 逐字推到前端
        response.Body.FlushAsync();
    }

    public async Task SendAsync(string evt, object? data, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(data, JsonOpts);
        if (response is null) return;
        var bytes = Encoding.UTF8.GetBytes($"event: {evt}\ndata: {json}\n\n");
        await response.Body.WriteAsync(bytes, ct);
        await response.Body.FlushAsync(ct);
    }
}
