// 文本抽取（对齐 services/extract.ts）：
// docx → DocumentFormat.OpenXml 抽取；pdf → PdfPig 抽文字；
// 文字型 PDF 识别文字过少视为扫描件 → PDFtoImage 渲染 PNG → 调 Python rapidocr

using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using PDFtoImage;
using SkiaSharp;
using UglyToad.PdfPig;

namespace ResumeAgent.Api.Services.Import;

public class ExtractResult
{
    public string Text { get; init; } = "";
    public string SourceType { get; init; } = "text"; // "text" | "ocr"
}

public class TextExtractor(ILogger<TextExtractor> logger, OcrRunner ocrRunner)
{
    // 文字型 PDF 若整篇识别文字少于该长度，视为扫描件，进入 OCR
    private const int OcrTextMin = 32;
    private static readonly HashSet<string> Allowed = [".docx", ".pdf"];

    public Task<ExtractResult> ExtractTextAsync(string fileName, byte[] buf) => Task.Run(() =>
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        if (!Allowed.Contains(ext))
            throw new InvalidOperationException("暂不支持该文件类型，请上传 .docx 或 .pdf（老式 .doc 请先另存为 .docx）");
        return ext == ".docx" ? ExtractDocx(buf) : ExtractPdf(buf);
    });

    // docx：按文档顺序遍历段落与表格，抽取纯文本（等价 mammoth extractRawText 的观感）
    private ExtractResult ExtractDocx(byte[] buf)
    {
        using var ms = new MemoryStream(buf);
        using var doc = WordprocessingDocument.Open(ms, false);
        var body = doc.MainDocumentPart?.Document.Body;
        var lines = new List<string>();
        if (body is not null) Collect(body.ChildElements, lines);
        var text = string.Join("\n", lines.Where(l => l.Trim().Length > 0)).Trim();
        return new ExtractResult { Text = text, SourceType = "text" };
    }

    private static void Collect(OpenXmlElementList elements, List<string> lines)
    {
        foreach (var el in elements)
        {
            switch (el)
            {
                case Paragraph p:
                    var t = p.InnerText;
                    if (t.Trim().Length > 0) lines.Add(t);
                    break;
                case Table tbl:
                    foreach (var row in tbl.Elements<TableRow>())
                    {
                        var cells = row.Elements<TableCell>().Select(c => c.InnerText.Trim());
                        var line = string.Join(" ", cells.Where(c => c.Length > 0));
                        if (line.Length > 0) lines.Add(line);
                    }
                    break;
                default:
                    if (el.ChildElements.Count > 0) Collect(el.ChildElements, lines);
                    break;
            }
        }
    }

    private ExtractResult ExtractPdf(byte[] buf)
    {
        var pdfText = ExtractPdfText(buf);
        if (pdfText.Trim().Length >= OcrTextMin)
            return new ExtractResult { Text = pdfText.Trim(), SourceType = "text" };

        var ocrText = OcrPdf(buf);
        var text = (pdfText.Trim().Length > 0 ? pdfText.Trim() : ocrText.Trim()).Trim();
        var sourceType = text == ocrText.Trim() && ocrText.Trim().Length > 0 ? "ocr" : "text";
        return new ExtractResult { Text = text, SourceType = sourceType };
    }

    // 文字型 PDF：逐页取文本（PdfPig）
    private static string ExtractPdfText(byte[] buf)
    {
        var parts = new List<string>();
        using var ms = new MemoryStream(buf);
        using var doc = PdfDocument.Open(ms);
        foreach (var page in doc.GetPages())
        {
            var words = page.GetWords().Select(w => w.Text);
            parts.Add(string.Join(" ", words));
        }
        return string.Join("\n", parts);
    }

    // 扫描件 PDF：逐页渲染成 PNG（144 DPI ≈ TS 版 scale=2）→ 调 Python rapidocr
    private string OcrPdf(byte[] buf)
    {
        var tmpDir = Directory.CreateTempSubdirectory("resume-ocr-").FullName;
        var pngs = new List<string>();
        try
        {
            var pageCount = Conversion.GetPageCount(buf, null);
            for (var i = 0; i < pageCount; i++)
            {
                using var bitmap = Conversion.ToImage(buf, i, null, new RenderOptions(Dpi: 144));
                var p = Path.Combine(tmpDir, $"page-{i + 1}.png");
                using var img = SKImage.FromBitmap(bitmap);
                using var data = img.Encode(SKEncodedImageFormat.Png, 100);
                using var fs = File.OpenWrite(p);
                data.SaveTo(fs);
                pngs.Add(p);
            }
            var res = ocrRunner.RunOcr(pngs);
            return res.Ok ? res.Text.Trim() : "";
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[OCR] PDF 渲染/识别失败");
            return "";
        }
        finally
        {
            try { Directory.Delete(tmpDir, recursive: true); } catch { /* 忽略清理失败 */ }
        }
    }
}
