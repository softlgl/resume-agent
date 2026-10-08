// 端点层共用的小工具：错误响应体、时间序列化、JsonNode 安全取值。
// 抽出来的原因：这三样东西原先在 6~8 个端点/服务文件里各抄一份，改契约要逐个改。

using System.Text.Json.Nodes;

namespace ResumeAgent.Api.Common;

public static class ApiJson
{
    /// <summary>统一错误响应体（契约固定：所有失败一律 { "error": msg }）</summary>
    public static IResult Error(string msg, int code) => Results.Json(new { error = msg }, statusCode: code);

    /// <summary>
    /// ISO 8601 UTC，固定 3 位毫秒小数位。
    /// MySQL 取回的 DateTime 不带时区标记，先按本地时间理解再转 UTC，与前端 JS 的 Date 行为对齐。
    /// </summary>
    public static string ToIso(DateTime v)
    {
        if (v.Kind == DateTimeKind.Unspecified) v = DateTime.SpecifyKind(v, DateTimeKind.Local);
        return v.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
    }

    public static string? ToIsoOrNull(DateTime? v) => v is null ? null : ToIso(v.Value);

    /// <summary>
    /// 安全取属性。
    /// JsonNode 的字符串索引器内部走 AsObject()，节点不是 JsonObject 时会抛
    /// "The node must be of type 'JsonObject'"——所有取值都必须走这里，别直接 node[key]。
    /// </summary>
    public static JsonNode? Prop(JsonNode? node, string key) =>
        node is JsonObject o ? o[key] : null;
}