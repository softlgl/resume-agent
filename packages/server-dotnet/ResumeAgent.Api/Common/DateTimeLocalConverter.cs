// MySQL 返回的 DateTime 无时区标记；序列化时按本地时间输出带时区的 ISO 8601（等价 JS toISOString 观感）

using System.Text.Json;
using System.Text.Json.Serialization;

namespace ResumeAgent.Api.Common;

public sealed class DateTimeLocalConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDateTime();

    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options)
    {
        if (value.Kind == DateTimeKind.Unspecified) value = DateTime.SpecifyKind(value, DateTimeKind.Local);
        writer.WriteStringValue(value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"));
    }
}