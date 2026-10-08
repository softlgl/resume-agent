// SSE 输出（对齐 TS 版手写的 `event: x\ndata: y\n\n` 帧格式，前端解析逻辑零改动）

using System.Text;
using System.Text.Json;

namespace ResumeAgent.Api.Endpoints;

public class SseWriter(HttpResponse? response)
{
    public static readonly JsonSerializerOptions JsonOptions = new()
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
        await response.Body.FlushAsync();
    }

    public async Task SendAsync(string eventName, object? data, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(data, JsonOptions);
        if (response is null) return;
        var bytes = Encoding.UTF8.GetBytes($"event: {eventName}\ndata: {json}\n\n");
        await response.Body.WriteAsync(bytes, ct);
        await response.Body.FlushAsync(ct);
    }

    /// <summary>同 SendAsync，但吞掉写入异常（客户端已断开等不应再抛给上层中间件）。
    /// 需要留痕时传 onError。</summary>
    public async Task TrySendAsync(string eventName, object? data, CancellationToken ct = default, Action<Exception>? onError = null)
    {
        try { await SendAsync(eventName, data, ct); }
        catch (Exception ex) { onError?.Invoke(ex); }
    }
}
