// 面试专用的历史装配（D 视图）与报告聚合 —— Node 与 .NET 的唯一实现（两边同构）
//
// 为什么单独一个文件、且不走 History.cs：
// History.cs 顶部已声明「C 读取（不走本文件）——面试要读 assistant 的 meta.probeDepth /
// meta.dimension，截断会丢依据」。面试必须按 questionId 分组：
//   - 当前追问链（同一 questionId）逐字保留、不截断到 History.MsgMaxChars=2000
//     （用户口述回答动辄上千字，而细节是追问的唯一依据，截断即失聪）；
//   - 已结束的题目压成一行摘要，保留「问过什么」以避免重复提问。
// 所以本文件只固化「按 createdAt asc 直读原始行」这一排序约定与分组/摘要/聚合逻辑。

using System.Text.Json;
using System.Text.Json.Nodes;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Edit;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Services.Ai;

/// <summary>面试历史的一行原始数据（直读，不做任何裁剪）</summary>
public sealed record InterviewRawRow(string Id, string Role, string Content, string? Meta, DateTime CreatedAt);

/// <summary>装配结果：当前链（逐字）+ 已结束题摘要 + 覆盖地图 + 面试计划</summary>
public sealed record AssembledHistory(
    List<ChatMessageItem> Chain,
    List<string> Digest,
    List<string> Covered,
    InterviewTurnMeta? Plan);

/// <summary>一道题 = 一个 questionId 分组</summary>
public sealed record QuestionGroup(string QuestionId, List<InterviewRawRow> Rows);

public static class InterviewHistory
{
    private static readonly JsonSerializerOptions NodeJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    // -----------------------------------------------------------------------
    // meta 解析
    // -----------------------------------------------------------------------

    public static InterviewTurnMeta? ParseMeta(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        try
        {
            return JsonSerializer.Deserialize<InterviewTurnMeta>(raw, AppDbContext.JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string? SerializeMeta(InterviewTurnMeta meta) =>
        JsonSerializer.Serialize(meta, AppDbContext.JsonOptions);

    /// <summary>字符串切片 + 去空，语义对齐 Node 的 cleanText</summary>
    public static string? CleanText(JsonNode? node, int max)
    {
        if (node is not JsonValue v || v.GetValueKind() != JsonValueKind.String) return null;
        var s = v.GetValue<string>()?.Trim() ?? "";
        return s.Length == 0 ? null : s[..Math.Min(max, s.Length)];
    }

    /// <summary>
    /// 安全取属性。
    /// JsonNode 的字符串索引器内部走 AsObject()，节点不是 JsonObject 时会抛
    /// "The node must be of type 'JsonObject'"——所有取值都必须走这里，别直接 node[key]。
    /// </summary>
    private static JsonNode? Prop(JsonNode? node, string key) =>
        node is JsonObject o ? o[key] : null;

    /// <summary>取字符串数组（过滤非字符串与空白项）</summary>
    public static List<string> StrArray(JsonObject? o, string key)
    {
        if (o is null || Prop(o, key) is not JsonArray arr) return [];
        return arr
            .Where(x => x is JsonValue v && v.GetValueKind() == JsonValueKind.String)
            .Select(x => x!.GetValue<string>())
            .ToList();
    }

    public static string DimensionOf(JsonNode? node) =>
        CleanText(Prop(node, "dimension"), 32) == InterviewDimension.Depth
            ? InterviewDimension.Depth
            : InterviewDimension.Authenticity;

    public static string VerdictOf(JsonNode? node)
    {
        var v = CleanText(Prop(node, "verdict"), 16);
        return v == InterviewVerdict.Fail ? InterviewVerdict.Fail
            : v == InterviewVerdict.Weak ? InterviewVerdict.Weak
            : InterviewVerdict.Pass;
    }

    public static int? ScoreOf(JsonNode? node)
    {
        if (Prop(node, "score") is not JsonValue sv || sv.GetValueKind() != JsonValueKind.Number) return null;
        var n = sv.GetValue<double>();
        if (double.IsNaN(n) || double.IsInfinity(n)) return null;
        return Math.Clamp((int)Math.Round(n), 0, 100);
    }

    /// <summary>
    /// 取判定依据的配对数组：quotes（用户原话）与 reasons（理由）。
    /// 模型经常给出不等长（甚至只给一边），这里以 min 长度截断对齐——
    /// 宁可少给一条依据，也绝不让前端出现「有理由没原话」的悬空项。
    /// 语义对齐 Node 的 cleanVerdictBasis。
    /// </summary>
    public static (List<string> Quotes, List<string> Reasons) VerdictBasis(JsonObject? parsed)
    {
        if (parsed is null) return ([], []);
        var quotes = StrArray(parsed, "quotes").Select(x => x.Trim()).ToList();
        var reasons = StrArray(parsed, "reasons").Select(x => x.Trim()).ToList();
        var n = Math.Min(quotes.Count, reasons.Count);
        return (quotes.Take(n).ToList(), reasons.Take(n).ToList());
    }

    /// <summary>
    /// 归一化模型给的 target：只接受 section[index]（不带字段名、不接受整段），
    /// 防止模型编造位置或粒度太粗。
    /// 语义对齐 Node 的 normalizeTarget(v)：**入参是 target 的值节点**，不是整个响应对象。
    /// </summary>
    public static string? NormalizeTarget(JsonNode? valueNode)
    {
        var raw = CleanText(valueNode, 64);
        if (raw is null) return null;
        var parsed = ResumeEditValidator.ParseFieldPath(raw);
        if (parsed is null || parsed.Key is not null || parsed.Index is null) return null;
        return $"{parsed.Section}[{parsed.Index}]";
    }

    // -----------------------------------------------------------------------
    // 简历条目切片（.NET 侧简历是强类型，直接取对象再脱敏，与 Node 的 sanitize(slice) 口径一致）
    // -----------------------------------------------------------------------

    public static (string Label, object? Item)? SliceTarget(ResumeContent content, string? target)
    {
        if (target is null) return null;
        var parsed = ResumeEditValidator.ParseFieldPath(target);
        if (parsed is null || parsed.Index is null) return null;
        object? item = parsed.Section switch
        {
            ResumeSection.Works => IndexOrNull(content.Works, parsed.Index.Value),
            ResumeSection.Projects => IndexOrNull(content.Projects, parsed.Index.Value),
            ResumeSection.Educations => IndexOrNull(content.Educations, parsed.Index.Value),
            ResumeSection.Skills => IndexOrNull(content.Skills, parsed.Index.Value),
            _ => null,
        };
        return item is null ? null : (ResumeEditValidator.BuildFieldLabel(target), item);
    }

    private static object? IndexOrNull<T>(List<T> list, int index) =>
        index >= 0 && index < list.Count ? list[index] : null;

    /// <summary>该简历到底有哪些条目可问（供「请换一条未覆盖的」有据可依）</summary>
    public static List<(string Path, string Label)> ListAskableItems(ResumeContent content)
    {
        var list = new List<(string, string)>();
        void Add(string section, int count)
        {
            for (var i = 0; i < count; i++)
            {
                var path = $"{section}[{i}]";
                list.Add((path, ResumeEditValidator.BuildFieldLabel(path)));
            }
        }
        Add(ResumeSection.Works, content.Works.Count);
        Add(ResumeSection.Projects, content.Projects.Count);
        Add(ResumeSection.Educations, content.Educations.Count);
        return list;
    }

    /// <summary>脱敏后序列化为进 prompt 的 JSON（不转义中文，避免体积膨胀）</summary>
    public static string ToPromptJson(object? value, ProfileSnapshotService snapshot, int maxChars = int.MaxValue)
    {
        var node = JsonSerializer.SerializeToNode(value, AppDbContext.JsonOptions);
        var sanitized = Prompts.SanitizeContent(node);
        var text = sanitized?.ToJsonString(NodeJson) ?? "null";
        return text.Length <= maxChars ? text : text[..maxChars];
    }

    // -----------------------------------------------------------------------
    // 预算：链拿大头（追问依据），摘要封顶（防线性增长）
    // -----------------------------------------------------------------------

    public readonly record struct HistoryBudgets(int Chain, int Digest);

    public static HistoryBudgets Budgets(ProfileSnapshotService snapshot)
    {
        var total = History.ContextCharBudget(snapshot);
        return new HistoryBudgets(
            Math.Min(InterviewPrompts.ChainTotalMaxChars, (int)Math.Floor(total * 0.4)),
            Math.Min(InterviewPrompts.DigestTotalMaxChars, (int)Math.Floor(total * 0.1)));
    }

    /// <summary>摘要行双封顶：先按行数从旧到新丢，再按字符总量从旧到新丢</summary>
    public static List<string> TrimDigest(List<string> lines, int maxChars)
    {
        var kept = new List<string>();
        var used = 0;
        foreach (var line in lines.AsEnumerable().Reverse().Take(InterviewPrompts.MaxDigestLines))
        {
            used += line.Length;
            if (used > maxChars) break;
            kept.Insert(0, line);
        }
        return kept;
    }

    /// <summary>递归截断长字符串——保证裁剪后仍是合法 JSON（硬切 JSON 会让模型读到半截结构）</summary>
    private static JsonNode? TruncateStrings(JsonNode? node, int max)
    {
        switch (node)
        {
            case JsonValue v when v.GetValueKind() == JsonValueKind.String:
                {
                    var s = v.GetValue<string>();
                    return s.Length > max ? JsonValue.Create(s[..max] + "…") : JsonValue.Create(s);
                }
            case JsonArray arr:
                {
                    var outArr = new JsonArray();
                    foreach (var item in arr) outArr.Add(TruncateStrings(item, max));
                    return outArr;
                }
            case JsonObject obj:
                {
                    var outObj = new JsonObject();
                    foreach (var kv in obj) outObj[kv.Key] = TruncateStrings(kv.Value, max);
                    return outObj;
                }
            default:
                return node?.DeepClone();
        }
    }

    /// <summary>简历精简版：每 section 只留关键字段与前 keep 条（口径对齐 chat 的 compactResume）</summary>
    private static JsonObject CompactResume(JsonObject o, int keep)
    {
        JsonArray Cut(string section)
        {
            var arr = new JsonArray();
            if (o[section] is JsonArray items)
            {
                foreach (var item in items.Take(keep))
                {
                    if (item is not JsonObject it) continue;
                    var t = new JsonObject();
                    foreach (var key in new[] { "company", "role", "start", "end", "description", "name", "category", "items" })
                        if (it[key] is { } v) t[key] = v.DeepClone();
                    arr.Add(t);
                }
            }
            return arr;
        }

        var basic = new JsonObject();
        if (o["basic"] is JsonObject b)
        {
            foreach (var key in new[] { "name", "title", "summary", "currentStatus", "workYears" })
                if (b[key] is { } v) basic[key] = v.DeepClone();
        }

        return new JsonObject
        {
            ["basic"] = basic,
            ["works"] = Cut(ResumeSection.Works),
            ["projects"] = Cut(ResumeSection.Projects),
            ["skills"] = Cut(ResumeSection.Skills),
        };
    }

    /// <summary>渐进裁剪简历：每轮都重新序列化，输出永远是合法 JSON（绝不硬切字符串）</summary>
    public static (string Json, bool Trimmed) FitResumeJson(ResumeContent content, int budget)
    {
        var node = Prompts.SanitizeContent(JsonSerializer.SerializeToNode(content, AppDbContext.JsonOptions))
                   as JsonObject ?? [];
        var full = node.ToJsonString(NodeJson);
        if (full.Length <= budget) return (full, false);

        foreach (var keep in new[] { 3, 1 })
        {
            var json = CompactResume(node, keep).ToJsonString(NodeJson);
            if (json.Length <= budget) return (json, true);
        }
        foreach (var chars in new[] { 400, 120 })
        {
            var json = TruncateStrings(node.DeepClone(), chars)?.ToJsonString(NodeJson) ?? "null";
            if (json.Length <= budget) return (json, true);
        }
        return (TruncateStrings(node.DeepClone(), 40)?.ToJsonString(NodeJson) ?? "null", true);
    }

    // -----------------------------------------------------------------------
    // 分组 / 摘要 / 装配
    // -----------------------------------------------------------------------

    public static List<QuestionGroup> GroupByQuestion(List<InterviewRawRow> rows)
    {
        var groups = new List<QuestionGroup>();
        foreach (var r in rows)
        {
            var meta = ParseMeta(r.Meta);
            var qid = meta?.QuestionId;
            if (string.IsNullOrEmpty(qid) || qid == "report") continue; // plan / report 不进题组
            var last = groups.Count > 0 ? groups[^1] : null;
            if (last is not null && last.QuestionId == qid)
            {
                last.Rows.Add(r);
            }
            else
            {
                groups.Add(new QuestionGroup(qid, [r]));
            }
        }
        return groups;
    }

    /// <summary>一道已结束的题压成一行摘要：问什么 / 答了什么要点 / 判定如何</summary>
    public static string SummarizeGroup(QuestionGroup group) => SummarizeRows(group.Rows);

    /// <summary>摘要生成（可只传入一道题的部分轮次，用于链超预算时把早期轮次降级）</summary>
    public static string SummarizeRows(List<InterviewRawRow> rows)
    {
        var assistants = rows.Where(r => r.Role == ChatMessageRole.Assistant).ToList();
        var first = assistants.Count > 0 ? assistants[0] : null;
        var last = assistants.Count > 0 ? assistants[^1] : null;
        var fm = ParseMeta(first?.Meta);
        var lm = ParseMeta(last?.Meta);

        var flat = Flatten(first?.Content);
        var question = flat[..Math.Min(90, flat.Length)];
        var rawAnswer = lm?.Answered;
        if (string.IsNullOrWhiteSpace(rawAnswer))
        {
            var firstUser = rows.FirstOrDefault(r => r.Role == ChatMessageRole.User);
            rawAnswer = firstUser is null ? null : Flatten(firstUser.Content);
        }
        var answered = string.IsNullOrWhiteSpace(rawAnswer) ? "（未作答）" : rawAnswer!;
        var rounds = rows.Count(r => r.Role == ChatMessageRole.User);
        var depth = rows.Count == 0 ? 0 : rows.Max(r => ParseMeta(r.Meta)?.ProbeDepth ?? 0);
        var verdict = string.IsNullOrEmpty(lm?.Verdict) ? "" : $"判定 {lm!.Verdict}";
        var score = lm?.Score is null ? "未评分" : $"{lm.Score} 分";
        var gap = string.IsNullOrEmpty(lm?.Gap) ? "" : $"｜缺口：{Cut(lm!.Gap!, 60)}";
        var dim = InterviewPrompts.DimensionLabelOf(fm?.Dimension);
        var head = $"- [{dim}·{fm?.TargetLabel ?? "未定位"}] 问：{question} ｜";

        return rounds > 0
            ? head + $"答：{Cut(answered, InterviewPrompts.AnswerDigestMaxChars)} ｜{verdict}{score}{gap}（追问 {depth} 层，共 {rounds} 轮）"
            : head + "（早期追问内容已按预算省略）";
    }

    private static string Flatten(string? s) => (s ?? "").Replace('\n', ' ').Replace('\r', ' ').Trim();

    private static string Cut(string s, int max) => s.Length <= max ? s : s[..max];

    public static string ClampChain(string content) =>
        content.Length > InterviewPrompts.ChainMsgMaxChars
            ? content[..InterviewPrompts.ChainMsgMaxChars] + "…（已截断）"
            : content;

    /// <summary>
    /// 装配面试历史。
    /// </summary>
    /// <param name="currentQuestionId">当前追问链的 questionId；null 表示不保留任何链（用于「结束面试」/「换题」）</param>
    public static AssembledHistory Build(List<InterviewRawRow> rows, string? currentQuestionId, HistoryBudgets? budgets = null)
    {
        var b = budgets ?? new HistoryBudgets(InterviewPrompts.ChainTotalMaxChars, InterviewPrompts.DigestTotalMaxChars);
        var chain = new List<ChatMessageItem>();
        var digest = new List<string>();
        var covered = new List<string>();
        var seen = new HashSet<string>();
        InterviewTurnMeta? plan = null;

        foreach (var r in rows)
        {
            var m = ParseMeta(r.Meta);
            if (m is null) continue;
            if (m.IsPlan == true) { plan = m; continue; }
            if (m.IsReport == true) continue;
            if (!string.IsNullOrEmpty(m.Target) && seen.Add(m.Target!)) covered.Add(m.Target!);
        }

        var groups = GroupByQuestion(rows);
        var current = currentQuestionId is null ? null : groups.FirstOrDefault(g => g.QuestionId == currentQuestionId);

        if (current is not null)
        {
            // 当前链：从最新往回累加，超预算的早期轮次降级成摘要（不直接丢弃，否则会断掉判定依据）
            var kept = new List<InterviewRawRow>();
            var dropped = new List<InterviewRawRow>();
            var used = 0;
            for (var i = current.Rows.Count - 1; i >= 0; i--)
            {
                var r = current.Rows[i];
                var c = ClampChain(r.Content);
                if (used + c.Length > b.Chain && kept.Count > 0)
                {
                    dropped.Insert(0, r);
                    continue;
                }
                kept.Insert(0, r);
                used += c.Length;
            }
            chain = kept
                .Select(r => new ChatMessageItem(
                    r.Role == ChatMessageRole.Assistant ? ChatMessageRole.Assistant : ChatMessageRole.User,
                    ClampChain(r.Content)))
                .ToList();
            if (dropped.Count > 0) digest.Add(SummarizeRows(dropped));
        }

        foreach (var g in groups)
        {
            if (currentQuestionId is not null && g.QuestionId == currentQuestionId) continue;
            digest.Add(SummarizeGroup(g));
        }

        return new AssembledHistory(chain, TrimDigest(digest, b.Digest), covered, plan);
    }

    /// <summary>当前正在追问的 questionId 与该题已到达的深度</summary>
    /// <summary>追问深度的合法值：0 | 1 | 2。任何非有限数/负数/超界一律归 0，绝不让脏值写进 meta 污染后续轮次</summary>
    public static int SafeDepth(int v) => v <= 0 ? 0 : Math.Min(v, InterviewPrompts.MaxProbeDepth);

    /// <summary>
    /// 维度交替：模型天然倾向整场都用同一个维度（实测 4 题全是 authenticity，
    /// 报告里「技术深度」永远是 —）。所以维度改由服务端按已出题数强制交替，
    /// 再也不信任模型自选的 dimension。模型只负责在给定维度下出题。
    /// </summary>
    public static string NextDimension(IEnumerable<string?> asked)
    {
        var a = 0;
        var d = 0;
        foreach (var x in asked)
        {
            if (x == InterviewDimension.Depth) d++;
            else if (x == InterviewDimension.Authenticity) a++;
        }
        return d < a ? InterviewDimension.Depth : InterviewDimension.Authenticity;
    }

    /// <summary>
    /// 取**当前题**（最后一组）开题消息定的维度；判定轮必须沿用它，避免同一题中途换维度导致统计错位。
    /// 注意：首题的开题消息带 IsPlan，它正是 q1 的权威维度来源，所以这里**不能**跳过 IsPlan，
    /// 只需排除 report。否则会退化成"取第一个非 plan 题组"，从第 3 题起读到上一题的维度。
    /// </summary>
    public static string? QuestionDimensionOf(List<InterviewRawRow> rows)
    {
        var groups = GroupByQuestion(rows);
        if (groups.Count == 0) return null;
        var current = groups[^1];
        var opening = current.Rows.FirstOrDefault(r =>
            r.Role == ChatMessageRole.Assistant && ParseMeta(r.Meta)?.IsReport != true);
        var m = ParseMeta(opening?.Meta);
        if (m is null) return null;
        return m.Dimension == InterviewDimension.Depth ? InterviewDimension.Depth : InterviewDimension.Authenticity;
    }

    public static (string? QuestionId, int Depth) CurrentTurnState(List<InterviewRawRow> rows)
    {
        for (var i = rows.Count - 1; i >= 0; i--)
        {
            if (rows[i].Role != ChatMessageRole.Assistant) continue;
            var m = ParseMeta(rows[i].Meta);
            if (m is not null && m.IsReport != true && !string.IsNullOrEmpty(m.QuestionId))
            {
                return (m.QuestionId, SafeDepth(m.ProbeDepth));
            }
        }
        return (null, -1);
    }

    /// <summary>最近一次非报告消息的 target（追问时不换考察对象）</summary>
    public static string? LastTargetOf(List<InterviewRawRow> rows)
    {
        for (var i = rows.Count - 1; i >= 0; i--)
        {
            if (rows[i].Role != ChatMessageRole.Assistant) continue;
            var m = ParseMeta(rows[i].Meta);
            if (m is not null && m.IsReport != true && !string.IsNullOrEmpty(m.Target)) return m.Target;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // 报告聚合（分数本地算，模型不参与打分，保证可复现）
    // -----------------------------------------------------------------------

    public static InterviewReport Aggregate(string sessionId, List<InterviewRawRow> rows, int planTotal, bool finished)
    {
        var questions = new List<InterviewQuestionSummary>();
        var authScores = new List<int>();
        var depthScores = new List<int>();
        int? authWeakest = null, depthWeakest = null;
        string authWeakestText = "", depthWeakestText = "";

        foreach (var g in GroupByQuestion(rows))
        {
            var assistants = g.Rows.Where(r => r.Role == ChatMessageRole.Assistant).ToList();
            if (assistants.Count == 0) continue;
            var fm = ParseMeta(assistants[0].Meta);
            var lm = ParseMeta(assistants[^1].Meta);
            // 注意：IsPlan 的消息**不能**用来跳过整题——面试计划与「第 1 题开题」是同一条消息
            // （建会话时合成一次调用），跳过它就等于丢掉第 1 题全部三轮的分数。
            // report 消息由 GroupByQuestion 按 questionId == "report" 排除，这里再兜一层。
            if (fm is null || fm.IsReport == true) continue;

            // 判定依据要沿用「最后一次非空」，不能只看最后一条 assistant。
            // 模型在收尾轮（最深一层）通常认为已经判定过、不再重复引用原话，
            // 若只取 lm 就会出现「分数还在、依据却丢了」的情况（score 有 fallback，依据没有）。
            var basisMeta = assistants
                .Select(r => ParseMeta(r.Meta))
                .Where(m => m?.Quotes is { Count: > 0 })
                .LastOrDefault();

            // 以该题最后一次判定/评分为准（追问过程会修正初判）
            var score = lm?.Score ?? fm.Score;
            var verdict = lm?.Verdict ?? fm.Verdict;
            // 用户从未作答过这道题（点「换一题」跳过）——不参与均分，报告里单独标注
            var skipped = !g.Rows.Any(r => r.Role == ChatMessageRole.User);

            // 逐轮分数轨迹：每条判定轮都收进来。
            // 模型偶尔漏给 Score —— 这时照样要把这一轮记进轨迹（Score 留空），
            // 否则「模型没打分」这件事在界面上就彻底看不见了，用户只会以为功能没实现。
            var rounds = assistants
                .Select(r => ParseMeta(r.Meta))
                .Where(m => m is not null && m.IsPlan != true && m.IsReport != true
                            && (m.Score is not null || m.Verdict is not null || m.Quotes is { Count: > 0 }))
                .Select(m => new InterviewRoundScore(
                    m!.ProbeDepth,
                    m.Score is null ? null : Math.Clamp(m.Score.Value, 0, 100),
                    m.Verdict))
                .OrderBy(r => r.Depth)
                .ToList();

            if (score is not null)
            {
                if (fm.Dimension == InterviewDimension.Depth)
                {
                    depthScores.Add(score.Value);
                    if (depthWeakest is null || score < depthWeakest) { depthWeakest = score; depthWeakestText = Cut(Flatten(assistants[0].Content), 80); }
                }
                else
                {
                    authScores.Add(score.Value);
                    if (authWeakest is null || score < authWeakest) { authWeakest = score; authWeakestText = Cut(Flatten(assistants[0].Content), 80); }
                }
            }

            questions.Add(new InterviewQuestionSummary(
                g.QuestionId,
                fm.Dimension,
                fm.Target,
                fm.TargetLabel,
                assistants[0].Content.Trim(),
                g.Rows.Max(r => ParseMeta(r.Meta)?.ProbeDepth ?? 0),
                verdict,
                score,
                rounds.Count > 0 ? rounds : null,
                basisMeta?.Quotes is { Count: > 0 } ? basisMeta.Quotes : null,
                basisMeta?.Reasons is { Count: > 0 } ? basisMeta.Reasons : null,
                !string.IsNullOrEmpty(lm?.Gap) ? lm!.Gap : basisMeta?.Gap,
                skipped));
        }

        var all = authScores.Concat(depthScores).ToList();
        return new InterviewReport(
            sessionId,
            questions.Count,
            questions.Count(q => !q.Skipped),
            all.Count == 0 ? 0 : (int)Math.Round(all.Average()),
            Score(authScores, authWeakestText),
            Score(depthScores, depthWeakestText),
            planTotal,
            finished,
            questions);
    }

    private static DimensionScore Score(List<int> scores, string weakestText) => scores.Count == 0
        ? new DimensionScore(0, 0, null)
        : new DimensionScore((int)Math.Round(scores.Average()), scores.Count,
            string.IsNullOrEmpty(weakestText) ? null : weakestText);
}
