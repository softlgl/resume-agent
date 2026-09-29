// 简历导入域的结果模型

namespace ResumeAgent.Api.Services.Import;

public sealed class ExtractResult
{
    public string Text { get; init; } = "";
    public string SourceType { get; init; } = "text"; // "text" | "ocr"
}

public sealed class OcrResult
{
    public bool Ok { get; init; }
    public string Text { get; init; } = "";
    public string? Error { get; init; }
}