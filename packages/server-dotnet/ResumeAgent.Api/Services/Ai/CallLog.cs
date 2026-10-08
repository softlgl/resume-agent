// LLM 调用日志（统一出口，对齐 modules/ai/core/call-log.ts）
// 分析 / 对话 / 导入三条链路共用同一份实现。
// ok 语义由调用方决定：分析、对话固定 true；导入按「是否解析成功」传 content is not null。

using ResumeAgent.Api.Common;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Services.Ai;

public static class CallLog
{
    /// <summary>记录一次 AI 调用日志（保留全部历史，前端只展示最新一条）</summary>
    public static async Task RecordCallAsync(
        AppDbContext db, ProfileSnapshotService snapshot, string userId,
        string kind, string? resumeId, bool ok, string? reasoning, string? output,
        string? provider = null)
    {
        try
        {
            var cfg = snapshot.GetDefaultConfig();
            db.LlmCallLogs.Add(new LlmCallLog
            {
                Id = Cuid.New(),
                UserId = userId,
                Kind = kind,
                ResumeId = resumeId,
                Provider = provider ?? LlmDefaults.ProviderName(cfg.Provider),
                Model = cfg.Model,
                Ok = ok,
                Reasoning = reasoning,
                Output = output,
                CreatedAt = DateTime.Now,
            });
            await db.SaveChangesAsync();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[AI] 记录调用日志失败: {ex.Message}");
        }
    }
}