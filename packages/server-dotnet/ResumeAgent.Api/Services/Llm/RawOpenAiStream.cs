// 原始 OpenAI 兼容流式客户端（对齐 llm.ts 的 chatStream SSE 解析）
//
// 为什么需要它：OpenAI 官方 .NET SDK 在模型绑定阶段会丢弃非标准字段——
// 第三方 OpenAI 兼容端点（dashscope/豆包/DeepSeek 等）流式 delta 里的
// reasoning_content（思考过程）拿不到（TextReasoningContent 与
// AdditionalProperties 兜底均无效，数据在 SDK 反序列化时已丢失）。
// 实测 dashscope qwen3.8-flash 原始返回确实带 reasoning_content 逐字 delta。
// 因此除 OpenAI 官方协议外，其余 provider 的流式调用统一走本实现。

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ResumeAgent.Api.Common;

namespace ResumeAgent.Api.Services.Llm;

public static class RawOpenAiStream
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    /// <summary>流式调用 OpenAI 兼容 /chat/completions，返回最终 content 全文；失败返回 null</summary>
    public static async Task<string?> StreamAsync(
        LlmConfig cfg, IReadOnlyList<ChatMessageItem> items, ChatOptionsEx opts,
        bool useJsonObjectFormat, Action<string>? onReasoning, Action<string>? onContent,
        ILogger logger, CancellationToken ct)
    {
        var isLocal = LlmDefaults.IsLocal(cfg.Provider);
        var defaultMax = isLocal ? 4000 : 2000;
        var body = new Dictionary<string, object?>
        {
            ["model"] = cfg.Model,
            ["messages"] = items.Select(m => new { role = m.Role, content = m.Content }),
            ["temperature"] = opts.Temperature ?? 0.3,
            // 以 profile.maxOutput 作为真实上限收敛（对齐 TS）
            ["max_tokens"] = Math.Min(opts.MaxTokens ?? 6000, cfg.MaxOutput),
            ["stream"] = true,
        };
        // 第三方兼容端点只支持 json_object（json_schema 会 400，对齐 TS）
        if (useJsonObjectFormat) body["response_format"] = new { type = "json_object" };

        using var req = new HttpRequestMessage(HttpMethod.Post, cfg.BaseUrl.TrimEnd('/') + "/chat/completions");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.ApiKey);
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        HttpResponseMessage resp;
        try
        {
            resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "[LLM] {Provider} 流式网络异常", cfg.Provider);
            return null;
        }
        if (!resp.IsSuccessStatusCode)
        {
            var txt = await resp.Content.ReadAsStringAsync(ct);
            logger.LogError("[LLM] {Provider} 流式请求失败 {Status}: {Body}", cfg.Provider, (int)resp.StatusCode, txt);
            return null;
        }

        var accum = new StringBuilder();
        using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (!line.StartsWith("data:")) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") break;

            JsonElement chunk;
            try
            {
                chunk = JsonSerializer.Deserialize<JsonElement>(data);
            }
            catch (JsonException)
            {
                continue;
            }
            if (!chunk.TryGetProperty("choices", out var choices) || choices.GetArrayLength() == 0) continue;
            if (choices[0].ValueKind != JsonValueKind.Object ||
                !choices[0].TryGetProperty("delta", out var delta)) continue;

            // 思考过程：reasoning_content（dashscope/deepseek）或 reasoning（兜底）
            string? reasoning = null;
            if (delta.TryGetProperty("reasoning_content", out var rc) && rc.ValueKind == JsonValueKind.String)
                reasoning = rc.GetString();
            if (string.IsNullOrEmpty(reasoning) &&
                delta.TryGetProperty("reasoning", out var r2) && r2.ValueKind == JsonValueKind.String)
                reasoning = r2.GetString();
            if (!string.IsNullOrEmpty(reasoning)) onReasoning?.Invoke(reasoning);

            if (delta.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String)
            {
                var s = c.GetString();
                if (!string.IsNullOrEmpty(s))
                {
                    accum.Append(s);
                    onContent?.Invoke(s);
                }
            }
        }
        return accum.ToString().Trim();
    }
}
