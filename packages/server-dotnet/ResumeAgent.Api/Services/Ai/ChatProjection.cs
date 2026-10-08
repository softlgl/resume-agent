// 对话模块的公共装配层：DB 行 → 响应载荷、JSON 列的解析、JsonNode 取值小工具。
// 会话 / 消息 / 账本三组端点共用，原先都挤在 AiChatEndpoints.cs 里。

using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;

namespace ResumeAgent.Api.Services.Ai;

internal static class ChatProjection
{
    /// <summary>JSON 输出用：不转义中文（对齐 JS JSON.stringify 的原样输出，避免 prompt 体积膨胀）</summary>
    internal static readonly JsonSerializerOptions PrettyJsonOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static readonly JsonSerializerOptions NodeJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // -----------------------------------------------------------------------
    // 小工具
    // -----------------------------------------------------------------------

    internal static List<string> ParseFocus(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return [];
        try
        {
            var node = JsonNode.Parse(raw);
            if (node is not JsonArray arr) return [];
            return arr.Where(x => x is JsonValue v && v.GetValueKind() == JsonValueKind.String)
                .Select(x => x!.GetValue<string>())
                .ToList();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    internal static SessionMeta SessionToMeta(AiChatSession s, int messageCount, string? preview) => new(
        s.Id,
        s.ResumeId,
        s.Title,
        ParseFocus(s.Focus),
        s.Jd,
        messageCount,
        ApiJson.ToIso(s.LastMessageAt),
        // 无摘要时整个键不输出（对齐改造前的「有值才加键」）
        string.IsNullOrEmpty(preview) ? null : preview[..Math.Min(60, preview.Length)]);

    internal static ChatMessageRecord MessageToRecord(AiChatMessage r)
    {
        JsonNode? edits = null;
        if (!string.IsNullOrEmpty(r.Edits))
        {
            try { edits = JsonNode.Parse(r.Edits); }
            catch (JsonException) { edits = null; }
        }
        return new ChatMessageRecord(
            r.Id,
            r.SessionId,
            r.Role == ChatMessageRole.Assistant ? ChatMessageRole.Assistant : ChatMessageRole.User,
            r.Content,
            edits,
            ParseAppliedIndexes(r.AppliedIndexes),
            r.Reasoning,
            ApiJson.ToIso(r.CreatedAt));
    }

    internal static List<int> ParseAppliedIndexes(string? raw)
    {
        var list = new List<int>();
        if (string.IsNullOrEmpty(raw)) return list;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return list;
            foreach (var el in doc.RootElement.EnumerateArray())
                if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n)) list.Add(n);
        }
        catch (JsonException) { }
        return list;
    }

    internal static RevisionRecord RevisionPayload(AiRevision r) => new(
        r.Id,
        r.ResumeId,
        r.UserId,
        r.Source,
        r.Op,
        r.Section,
        r.Field,
        r.Label,
        r.BeforeValue,
        r.AfterValue,
        r.ItemId,
        r.SessionId,
        r.MessageId,
        ApiJson.ToIsoOrNull(r.RevertedAt),
        ApiJson.ToIso(r.CreatedAt));

    internal static JsonNode? AnalysisNode(Resume resume) =>
        string.IsNullOrEmpty(resume.AnalysisJson) ? null : TryParseNode(resume.AnalysisJson);

    internal static JsonNode? TryParseNode(string text)
    {
        try { return JsonNode.Parse(text); }
        catch (JsonException) { return null; }
    }

    /// <summary>模拟 JS 的 String(x ?? "")：字符串原样、数字取字面量、布尔转字面量，其余为空串</summary>
    internal static string ToJsString(JsonNode? n) => n switch
    {
        JsonValue v => v.GetValueKind() switch
        {
            JsonValueKind.String => v.GetValue<string>() ?? "",
            JsonValueKind.Number => v.GetValue<JsonElement>().GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",
        },
        _ => "",
    };

    /// <summary>仅当是 JSON 字符串时取值（对齐 TS 的 typeof x === "string"）</summary>
    internal static string GetStringOr(JsonNode? n, string def) =>
        n is JsonValue v && v.GetValueKind() == JsonValueKind.String ? v.GetValue<string>() ?? def : def;

    internal static bool IsTrue(JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    internal static JsonElement ToJsonElement(JsonNode? node)
    {
        if (node is null) return default;
        using var doc = JsonDocument.Parse(node.ToJsonString(NodeJsonOptions));
        return doc.RootElement.Clone();
    }

    /// <summary>对齐 JS 的 `Number(x) || def` 再夹取范围（0 与 NaN 都回落默认值）</summary>
    internal static int ParseLimit(string? raw, int def, int max)
    {
        var n = int.TryParse((raw ?? "").Trim(), out var parsed) ? parsed : 0;
        if (n == 0) n = def;
        return Math.Min(Math.Max(n, 1), max);
    }

    // -----------------------------------------------------------------------
    // JSON 取值辅助
    // -----------------------------------------------------------------------

    internal static string GetStringProperty(JsonElement obj, string prop) =>
        obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString()! : "";

    /// <summary>对齐 TS：asks.filter(a =&gt; typeof a === "string" &amp;&amp; !!a.trim()).slice(0, 4)（保留原值不 trim）</summary>
    internal static List<string> GetStringArray(JsonElement obj, string prop)
    {
        var list = new List<string>();
        if (!obj.TryGetProperty(prop, out var el) || el.ValueKind != JsonValueKind.Array) return list;
        foreach (var item in el.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) continue;
            var s = item.GetString()!;
            if (s.Trim().Length == 0) continue;
            list.Add(s);
            if (list.Count >= 4) break;
        }
        return list;
    }
}
