// 对话历史的读取与裁剪 —— Node 与 .NET 的唯一实现（两边同构，禁止出现第三份）
//
// 三类读取，别混用：
// - A 视图 GetHistoryForLLM：喂给 LLM 的历史消息（角色归一 + 单条截断 + 尾部按预算累积）
// - B 视图 GetRecentUserText：用户原话（仅 user 角色 + 本条），供事实核验与时间抽取
// - C 读取（不走本文件）：面试要读 assistant 的 meta.probeDepth / meta.dimension，
//   截断会丢依据，因此按 orderBy createdAt asc 直读原始行，本文件只固化这个排序约定
// 未来若做摘要压缩：只替换 GetHistoryForLLM 的函数体，签名保持不变。

using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Services.Ai;

/// <summary>历史消息行（角色 + 内容），对齐 Node 的 HistoryRow</summary>
public readonly record struct HistoryRow(string Role, string Content);

public static class History
{
    public const int MaxCount = 12;      // 最多带最近 12 条历史
    public const int MsgMaxChars = 2000; // 单条历史消息字符上限

    /// <summary>按 LLM 上下文预算推算可用于历史的字符数（简历 JSON 压缩也复用本函数）</summary>
    public static int ContextCharBudget(ProfileSnapshotService snapshot)
    {
        // maxContext 是 token 数；中文约 1 token/字，留 45% 给历史并按 1.5 倍保守放大
        var maxContext = snapshot.GetConfig()?.MaxContext ?? 32768;
        return (int)Math.Floor(maxContext * 0.45 * 1.5);
    }

    /// <summary>A 视图：最近 MaxCount 条内，单条截断，再从最新往回累积到预算为止</summary>
    public static List<ChatMessageItem> GetHistoryForLLM(List<HistoryRow> rows, int maxChars)
    {
        var recent = rows.Count > MaxCount ? rows.Skip(rows.Count - MaxCount).ToList() : rows;
        var outList = new List<ChatMessageItem>();
        var used = 0;
        for (var i = recent.Count - 1; i >= 0; i--)
        {
            var r = recent[i];
            var c = r.Content.Length > MsgMaxChars
                ? r.Content[..MsgMaxChars] + "…（已截断）"
                : r.Content;
            if (outList.Count > 0 && used + c.Length > maxChars) break;
            outList.Insert(0, new ChatMessageItem(r.Role == ChatMessageRole.Assistant ? ChatMessageRole.Assistant : ChatMessageRole.User, c));
            used += c.Length;
        }
        return outList;
    }

    /// <summary>
    /// B 视图：用户最近说过的话（仅 user 角色，含本条）。
    /// 事实核验与时间抽取都只认用户自己的话——AI 回复里天然带大量日期，
    /// 混进来会让「哪段日期属于本条经历」的判断失真。
    /// </summary>
    public static string GetRecentUserText(List<HistoryRow> rows, string currentText)
    {
        var recent = rows.Count > MaxCount ? rows.Skip(rows.Count - MaxCount).ToList() : rows;
        return string.Join("\n",
            recent.Where(r => r.Role == ChatMessageRole.User).Select(r => r.Content).Append(currentText));
    }
}