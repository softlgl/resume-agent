// 原始 OpenAI 兼容 /chat/completions 客户端（对齐 llm.ts 的 chat / chatStream 线协议）
//
// 为什么所有 provider（含 openai 官方）都走这里，而不用 MEAI / OpenAI 官方 SDK：
// 1) OpenAI .NET SDK 在模型绑定阶段会丢弃非标准字段——第三方 OpenAI 兼容端点
//    （dashscope/豆包/DeepSeek 等）流式 delta 里的 reasoning_content（思考过程）拿不到
//    （TextReasoningContent 与 AdditionalProperties 兜底均无效，数据在 SDK 反序列化时已丢失）。
//    实测 dashscope qwen3.8-flash 原始返回确实带 reasoning_content 逐字 delta。
// 2) MEAI 的 ChatOptions.AdditionalProperties 只是给客户端实现读取的状态包，并不会被
//    并入线上请求体——思考开关（enable_thinking / thinking / reasoning_effort 等）会被静默吞掉。
//    实测 openai provider 设 on/off 后请求体里没有 reasoning_effort，故统一改为自建请求体。

using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using ResumeAgent.Api.Common;

namespace ResumeAgent.Api.Services.Llm;

public static class RawOpenAiStream
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };

    /// <summary>发送请求；失败（网络异常或非 2xx）返回 null 并记录日志</summary>
    private static async Task<HttpResponseMessage?> SendAsync(
        LlmConfig cfg, OpenAiChatRequest body, ILogger logger, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, cfg.BaseUrl.TrimEnd('/') + "/chat/completions");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", cfg.ApiKey);
        req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        try
        {
            var resp = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (resp.IsSuccessStatusCode) return resp;
            var txt = await resp.Content.ReadAsStringAsync(ct);
            logger.LogError("[LLM] {Provider} 请求失败 {Status}: {Body}", cfg.Provider, (int)resp.StatusCode, txt);
            resp.Dispose();
            return null;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "[LLM] {Provider} 网络异常", cfg.Provider);
            return null;
        }
    }

    /// <summary>非流式调用（对齐 TS 的 chat()）：失败返回 null</summary>
    public static async Task<ChatResult?> CompleteAsync(
        LlmConfig cfg, OpenAiChatRequest body, ILogger logger, CancellationToken ct)
    {
        using var resp = await SendAsync(cfg, body, logger, ct);
        if (resp is null) return null;

        var raw = await resp.Content.ReadAsStringAsync(ct);
        OpenAiCompletionResponse? data;
        try
        {
            data = JsonSerializer.Deserialize<OpenAiCompletionResponse>(raw);
        }
        catch (JsonException)
        {
            logger.LogError("[LLM] {Provider} 响应解析失败: {Body}", cfg.Provider, raw);
            return null;
        }

        var msg = data?.Choices is { Count: > 0 } ? data.Choices[0].Message : null;
        var text = !string.IsNullOrEmpty(msg?.Content) ? msg!.Content!
            : !string.IsNullOrEmpty(msg?.ReasoningContent) ? msg!.ReasoningContent!
            : msg?.Reasoning ?? "";
        return new ChatResult
        {
            Text = CleanFences(text),
            PromptTokens = data?.Usage?.PromptTokens,
            CompletionTokens = data?.Usage?.CompletionTokens,
        };
    }

    /// <summary>流式调用：返回最终 content 全文；失败返回 null</summary>
    public static async Task<string?> StreamAsync(
        LlmConfig cfg, OpenAiChatRequest body,
        Func<string, Task>? onReasoning, Func<string, Task>? onContent,
        ILogger logger, CancellationToken ct)
    {
        using var resp = await SendAsync(cfg, body, logger, ct);
        if (resp is null) return null;

        var accum = new StringBuilder();
        using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (!line.StartsWith("data:")) continue;
            var data = line[5..].Trim();
            if (data == "[DONE]") break;

            OpenAiStreamChunk? chunk;
            try
            {
                chunk = JsonSerializer.Deserialize<OpenAiStreamChunk>(data);
            }
            catch (JsonException)
            {
                continue;
            }
            if (chunk?.Choices is not { Count: > 0 }) continue;
            var delta = chunk.Choices[0].Delta;
            if (delta is null) continue;

            // 思考过程：reasoning_content（dashscope/deepseek）或 reasoning（兜底）
            var reasoning = !string.IsNullOrEmpty(delta.ReasoningContent) ? delta.ReasoningContent : delta.Reasoning;
            if (!string.IsNullOrEmpty(reasoning) && onReasoning is not null) await onReasoning(reasoning);

            if (!string.IsNullOrEmpty(delta.Content))
            {
                accum.Append(delta.Content);
                if (onContent is not null) await onContent(delta.Content);
            }
        }
        return accum.ToString().Trim();
    }

    /// <summary>对齐 TS 的 ``` 围栏清理：模型偶发输出 markdown 代码块包裹的 JSON</summary>
    private static string CleanFences(string text)
    {
        var t = text.Trim();
        if (t.StartsWith("```"))
        {
            var firstNl = t.IndexOf('\n');
            if (firstNl > 0) t = t[(firstNl + 1)..];
            if (t.EndsWith("```")) t = t[..^3];
        }
        return t.Trim();
    }
}
