// /import 模块（对齐 modules/ai/import.ts）：上传 .docx/.pdf → 抽取文本(扫描件走 OCR) → LLM 结构化 → SSE 流式返回
// 流式输出：status(提取完成) → reasoning(结构化思考过程,逐字) → result(最终结构) / done

using System.Security.Claims;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Ai;
using ResumeAgent.Api.Services.Import;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Endpoints.Ai;

public static class ImportEndpoints
{
    public static IEndpointRouteBuilder MapImportEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/import/parse", async (
            ClaimsPrincipal principal, AppDbContext db,
            TextExtractor extractor, Structurizer structurizer, ProfileSnapshotService snapshot,
            HttpContext http, CancellationToken requestAborted) =>
        {
            var userId = principal.UserId();
            if (userId is null) return ApiJson.Error("未登录", 401);

            var file = http.Request.Form.Files.FirstOrDefault();
            if (file is null) return ApiJson.Error("未收到文件", 400);
            var fileName = file.FileName is { Length: > 0 } ? file.FileName : "resume";

            byte[] buf;
            await using (var ms = new MemoryStream())
            {
                await file.CopyToAsync(ms, requestAborted);
                buf = ms.ToArray();
            }

            ExtractResult extract;
            try
            {
                extract = await extractor.ExtractTextAsync(fileName, buf);
            }
            catch (Exception ex)
            {
                return ApiJson.Error(ex.Message, 400);
            }

            // 文件解析完成，切换为 SSE 流
            var sse = new SseWriter(http.Response);
            await sse.InitAsync();
            await sse.SendAsync("status", new { message = "文本已提取，正在识别…" }, requestAborted);

            // 敏感信息本地抽取并在发往 LLM 前替换为占位（避免姓名/电话/邮箱/地址外发）；AI 完成后回填真值
            var sensitive = RedactService.ExtractSensitive(extract.Text);
            // 所在地无明确标签时启发式不可靠：不本地回填也不脱敏，交由 LLM 推断，避免错值覆盖
            if (!sensitive.LocationReliable) sensitive.Location = "";
            var sendText = RedactService.RedactText(extract.Text, sensitive);

            Contracts.ResumeContent? content = null;
            string? note = null;
            var importReasoning = "";
            var importOutput = "";
            try
            {
                content = await structurizer.StructurizeTextAsync(sendText,
                    async d => { importReasoning += d; await sse.SendAsync("reasoning", new { delta = d }, requestAborted); },
                    async d => { importOutput += d; await sse.SendAsync("content", new { delta = d }, requestAborted); },
                    requestAborted);
            }
            catch
            {
                content = null;
            }
            if (content is null)
            {
                note = "未配置 LLM 或自动识别失败，文本已提取，请手动填写。";
            }
            else
            {
                // 归一：项目所属公司尽量匹配到工作经历里的公司名（模糊/包含），不中则留空
                var companies = content.Works.Select(w => w.Company.Trim()).Where(c => c.Length > 0).ToList();
                string Fit(string candidate)
                {
                    var t = candidate.Trim();
                    if (t.Length == 0 || companies.Count == 0) return "";
                    var lower = t.ToLowerInvariant();
                    var hit = companies.FirstOrDefault(c => c.ToLowerInvariant() == lower);
                    if (hit is not null) return hit;
                    var contain = companies.FirstOrDefault(c =>
                        c.ToLowerInvariant().Contains(lower) || lower.Contains(c.ToLowerInvariant()));
                    return contain ?? "";
                }
                foreach (var p in content.Projects) p.Company = Fit(p.Company);
                // 敏感信息回填：用本地抽取的真实值覆盖 basic（地址→location；未抽到的字段保持 AI 结果）
                RedactService.RestoreSensitive(content, sensitive);
            }

            // 记录一次【导入】调用日志（按 userId，无简历 id）；ok 按「是否结构化成功」写入
            await CallLog.RecordCallAsync(db, snapshot, userId, LlmCallKind.Import, null,
                ok: content is not null,
                reasoning: importReasoning.Length > 0 ? importReasoning : null,
                output: content is not null
                    ? System.Text.Json.JsonSerializer.Serialize(content, SseWriter.JsonOptions)
                    : importOutput.Length > 0 ? importOutput : null);

            await sse.SendAsync("result", new
            {
                fileName,
                sourceText = extract.Text,
                ocrUsed = extract.SourceType == "ocr",
                content,
                note,
            }, requestAborted);
            await sse.SendAsync("done", new { ok = true }, requestAborted);
            return Results.Empty;
        });

        return app;
    }
}
