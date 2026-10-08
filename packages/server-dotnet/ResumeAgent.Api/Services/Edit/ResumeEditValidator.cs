// AI 修改建议的服务端权威校验层（packages/server/src/services/resume-edit.ts 的 C# 等价实现）
// 职责：把 AI 产出的原始 edit 归一化成前端可安全应用的 ResumeEdit，
//       挡住路径注入、下标越界、容器覆写、AI 编造事实字段等风险。
// 前端 applyEdit 仍有二次防御，但这里是唯一的事实来源。
//
// 移植约定：正则里的 \d/\D 显式写成 [0-9]/[^0-9]——JS 只认 ASCII 数字，
// 而 .NET 默认 \d 会匹配 Unicode 数字，只有等价写法才能保证两边行为一致。

using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Services.Edit;

public static class ResumeEditValidator
{
    // -----------------------------------------------------------------------
    // 常量表
    // -----------------------------------------------------------------------

    /// <summary>每个 section 允许被 set/append 的字段（仅 string 类型；works.current 是 boolean，排除）</summary>
    public static readonly Dictionary<string, string[]> SettableFields = new()
    {
        [ResumeSection.Basic] =
        [
            "name", "title", "phone", "email", "location", "website", "summary", "avatar",
            "birthday", "gender", "currentStatus", "expectedSalary", "workYears",
        ],
        [ResumeSection.Works] = ["company", "role", "start", "end", "description"],
        [ResumeSection.Educations] = ["school", "major", "degree", "start", "end", "description"],
        [ResumeSection.Projects] = ["name", "company", "role", "start", "end", "link", "description"],
        [ResumeSection.Skills] = ["category", "items"],
    };

    /// <summary>append 必填项（口径与 modules/ai/analyze.ts 的 ruleChecks 对齐）</summary>
    public static readonly Dictionary<string, string[]> AppendRequired = new()
    {
        [ResumeSection.Works] = ["company", "role", "start"],
        [ResumeSection.Educations] = ["school", "start"],
        [ResumeSection.Projects] = ["name"],
        [ResumeSection.Skills] = ["category", "items"],
    };

    /// <summary>append 时的事实字段：AI 不得凭空产生，只有用户明确说过的才保留，否则置空由用户在卡片里补</summary>
    public static readonly string[] AppendBlankFacts = ["start", "end", "link"];

    /// <summary>append 中需在对话原文里出现过才可信的字段 → 未出现时写入 risks</summary>
    private static readonly Dictionary<string, string[]> AppendVerifyInText = new()
    {
        [ResumeSection.Works] = ["company"],
        [ResumeSection.Educations] = ["school"],
        [ResumeSection.Projects] = ["name"],
    };

    private static readonly Dictionary<string, string> SectionLabels = new()
    {
        [ResumeSection.Basic] = "基本信息",
        [ResumeSection.Works] = "工作经历",
        [ResumeSection.Educations] = "教育经历",
        [ResumeSection.Projects] = "项目经历",
        [ResumeSection.Skills] = "技能",
    };

    private static readonly Dictionary<string, string> FieldLabels = new()
    {
        ["name"] = "姓名",
        ["title"] = "求职意向",
        ["phone"] = "手机号",
        ["email"] = "邮箱",
        ["location"] = "所在地",
        ["website"] = "个人主页",
        ["summary"] = "个人简介",
        ["avatar"] = "头像",
        ["birthday"] = "出生年月",
        ["gender"] = "性别",
        ["currentStatus"] = "当前状态",
        ["expectedSalary"] = "期望薪资",
        ["workYears"] = "工作年限",
        ["company"] = "公司名称",
        ["role"] = "职位",
        ["start"] = "开始时间",
        ["end"] = "结束时间",
        ["current"] = "是否至今",
        ["description"] = "描述",
        ["school"] = "学校",
        ["major"] = "专业",
        ["degree"] = "学历",
        ["link"] = "项目链接",
        ["category"] = "分类",
        ["items"] = "技能",
    };

    /// <summary>同名字段在不同 section 下的中文名不同（projects.name 是项目名称，不是姓名）</summary>
    private static readonly Dictionary<string, Dictionary<string, string>> SectionFieldOverrides = new()
    {
        [ResumeSection.Projects] = new() { ["name"] = "项目名称" },
    };

    /// <summary>
    /// 字段路径里每个名字的「规范拼写」，大小写不敏感查找。
    /// 取SettableFields 与 FieldLabels 的并集：前者是可写字段，后者是标签表——
    /// 两边都要，否则会出现「标签认得、定位不认得」的分裂。
    /// </summary>
    private static readonly Dictionary<string, string> CanonicalKeys = BuildCanonicalKeys();

    private static Dictionary<string, string> BuildCanonicalKeys()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var section in SettableFields.Keys) map[section] = section;
        foreach (var fields in SettableFields.Values)
            foreach (var f in fields) map[f] = f;
        foreach (var key in FieldLabels.Keys) map[key] = key;
        return map;
    }

    // -----------------------------------------------------------------------
    // 路径解析
    // -----------------------------------------------------------------------

    private static readonly string SectionNames = string.Join("|", SettableFields.Keys);
    private static readonly Regex PathRegex = new(
        $@"^({SectionNames})(?:\[([0-9]+)\])?(?:\.([A-Za-z0-9_]+))?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex PathSplitRegex = new(@"[.\[\]]+", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex IndexRegex = new(@"\[([0-9]+)\]", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public sealed record ParsedPath(string Section, int? Index, string? Key);

    /// <summary>解析 "works[0].description" / "basic.summary"；不合法返回 null</summary>
    public static ParsedPath? ParseFieldPath(string? field)
    {
        if (field is null) return null;
        var m = PathRegex.Match(field.Trim());
        if (!m.Success) return null;
        return new ParsedPath(
            m.Groups[1].Value,
            m.Groups[2].Success ? int.Parse(m.Groups[2].Value) : null,
            m.Groups[3].Success ? m.Groups[3].Value : null);
    }

    /// <summary>
    /// 把模型给出的字段路径收敛到简历 JSON 的真实键（大小写不敏感 → 规范拼写）。
    /// 模型常返回 PascalCase（Works[0].Description）或把 camelKey 打成全小写
    /// （basic.currentstatus）。
    ///
    /// 为什么不能整体 ToLower：前端按真实键定位字段、按 FIELD_LABELS 渲染中文标签。
    /// 小写化会把 currentStatus 变成 currentstatus，于是
    ///   1）fieldToLabel 查不到标签，卡片显示成「基本信息 · currentstatus」；
    ///   2）前端 FIELD_RE 允许任意键名，会通过校验并把改写写进一个不存在的
    ///      currentstatus 键——简历里看不到任何变化。
    /// 因此这里只做「查表换成规范拼写」，认不出来的名字保持原样，不擅自改写。
    /// </summary>
    public static string NormalizeFieldPath(string? field)
    {
        if (string.IsNullOrWhiteSpace(field)) return "";
        var parts = new List<string>();
        foreach (var raw in PathSplitRegex.Split(field.Trim()))
        {
            if (raw.Length == 0) continue;
            if (int.TryParse(raw, out _))
            {
                // 下标接回上一段名字：works + 0 → works[0]
                if (parts.Count > 0) parts[^1] += "[" + raw + "]";
                continue;
            }
            parts.Add(CanonicalKeys.TryGetValue(raw, out var canonical) ? canonical : raw);
        }
        return parts.Count == 0 ? field.Trim() : string.Join('.', parts);
    }

    /// <summary>
    /// 从模型给出的若干候选键里挑出真正的字段路径。
    /// 优先选含 "." 或 "[" 的（真正指向某个字段），全都不是时按序取第一个非空。
    ///
    /// 为什么不能按固定顺序取第一个非空：模型可能同时返回 section 与 field
    /// （prompt 只要求 field，并不禁止多吐 section）。固定顺序会取到 section 名
    /// （如 "works"），随后被「整段容器字段不给 rewrite」的规则清掉 rewrite——
    /// 建议还在，但「应用改写」按钮无声消失，日志里也没有任何记录。
    ///
    /// 候选顺序即回退顺序：path → field → key → section，真实字段路径的键在前，分区名垫底。
    /// </summary>
    public static string PickFieldPath(params string?[] candidates)
    {
        var list = new List<string>();
        foreach (var c in candidates)
            if (!string.IsNullOrWhiteSpace(c)) list.Add(c);
        var picked = list.FirstOrDefault(c => c.Contains('.') || c.Contains('['));
        return picked ?? (list.Count > 0 ? list[0] : "");
    }

    /// <summary>section 的中文名（供拼装追问文案）</summary>
    public static string SectionLabel(string section) =>
        SectionLabels.TryGetValue(section, out var v) ? v : section;

    /// <summary>把 JSON 路径转成中文可读定位文本（与前端 fieldToLabel 口径一致）</summary>
    public static string BuildFieldLabel(string field)
    {
        if (string.IsNullOrEmpty(field)) return "";
        var parsed = ParseFieldPath(field);
        var rawTokens = PathSplitRegex.Split(field);
        var top = parsed?.Section ?? rawTokens[0];
        var section = SectionLabels.TryGetValue(top, out var sv) ? sv : top;

        var idxMatch = IndexRegex.Match(field);
        var idxPart = idxMatch.Success ? $" · 第{int.Parse(idxMatch.Groups[1].Value) + 1}条" : "";

        var tokens = rawTokens.Where(t => t.Length > 0).ToList();
        var lastKey = tokens.Count > 0 ? tokens[^1] : "";

        string? over = null;
        if (parsed is not null
            && SectionFieldOverrides.TryGetValue(parsed.Section, out var ov)
            && ov.TryGetValue(lastKey, out var ovv)) over = ovv;
        var fieldName = !string.IsNullOrEmpty(over)
            ? over
            : FieldLabels.TryGetValue(lastKey, out var fl) ? fl : lastKey;

        return $"{section}{idxPart} · {fieldName}";
    }

    /// <summary>读取路径指向的当前值（只支持 basic.key 与 section[idx].key 两种形态）</summary>
    public static string? ReadFieldValue(ResumeContent content, string field)
    {
        var parsed = ParseFieldPath(field);
        if (parsed is null || parsed.Key is null) return null;
        var key = parsed.Key;
        if (parsed.Section == ResumeSection.Basic) return ReadBasicValue(content.Basic, key);
        if (parsed.Index is null) return null;
        return ReadListValue(content, parsed.Section, parsed.Index.Value, key);
    }

    private static string? ReadBasicValue(BasicInfo basic, string key) => key switch
    {
        "name" => basic.Name,
        "title" => basic.Title,
        "phone" => basic.Phone,
        "email" => basic.Email,
        "location" => basic.Location,
        "website" => basic.Website,
        "summary" => basic.Summary,
        "avatar" => basic.Avatar,
        "birthday" => basic.Birthday,
        "gender" => basic.Gender,
        "currentStatus" => basic.CurrentStatus,
        "expectedSalary" => basic.ExpectedSalary,
        "workYears" => basic.WorkYears,
        _ => null,  // 非 string 字段（TS 版同样返回 null）
    };

    private static string? ReadListValue(ResumeContent content, string section, int index, string key)
    {
        switch (section)
        {
            case ResumeSection.Works:
                if (index >= content.Works.Count) return null;
                var w = content.Works[index];
                return key switch
                {
                    "company" => w.Company, "role" => w.Role, "start" => w.Start,
                    "end" => w.End, "description" => w.Description, _ => null,  // current 是 bool
                };
            case ResumeSection.Educations:
                if (index >= content.Educations.Count) return null;
                var e = content.Educations[index];
                return key switch
                {
                    "school" => e.School, "major" => e.Major, "degree" => e.Degree,
                    "start" => e.Start, "end" => e.End, "description" => e.Description, _ => null,
                };
            case ResumeSection.Projects:
                if (index >= content.Projects.Count) return null;
                var p = content.Projects[index];
                return key switch
                {
                    "name" => p.Name, "company" => p.Company, "role" => p.Role, "start" => p.Start,
                    "end" => p.End, "link" => p.Link, "description" => p.Description, _ => null,
                };
            case ResumeSection.Skills:
                if (index >= content.Skills.Count) return null;
                var s = content.Skills[index];
                return key switch { "category" => s.Category, "items" => s.Items, _ => null };
            default:
                return null;
        }
    }

    private static int? SectionCount(ResumeContent content, string section) => section switch
    {
        ResumeSection.Works => content.Works.Count,
        ResumeSection.Educations => content.Educations.Count,
        ResumeSection.Projects => content.Projects.Count,
        ResumeSection.Skills => content.Skills.Count,
        _ => null,
    };

    private const string Base36 = "0123456789abcdefghijklmnopqrstuvwxyz";

    /// <summary>与前端 SectionForm.uid() 同风格的条目 id（36 进制小写字母数字串）</summary>
    public static string NewItemId() =>
        ToBase36((ulong)Random.Shared.NextInt64()) + ToBase36((ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    private static string ToBase36(ulong v)
    {
        if (v == 0) return "0";
        var sb = new StringBuilder();
        while (v > 0)
        {
            sb.Insert(0, Base36[(int)(v % 36)]);
            v /= 36;
        }
        return sb.ToString();
    }

    // -----------------------------------------------------------------------
    // 事实字段防线
    // -----------------------------------------------------------------------

    // AI 不可能知道、也不允许编造的真实值（时间/链接/联系方式/薪资/出生年月等）
    private static readonly Regex[] NoRewritePatterns =
    [
        new(
            @"\.(start|end|link|url|github|gitee|phone|mobile|tel|email|mail|qq|wechat|wx|address|location|salary|expect|expectedSalary|birthday|birth|age|gender|avatar|photo|image|portfolio|blog|website|homepage|doubao|zhihu|bilibili|juejin|csdn|leetcode|hotjob|jobPosition|jobLevel)$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant),
        new(@"^basic\.(name|realName)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant),
    ];

    /// <summary>该字段是否禁止 AI 改写（命中则整条 edit 丢弃）</summary>
    public static bool IsNoRewriteField(string field) => NoRewritePatterns.Any(re => re.IsMatch(field));

    // 姓名任何情况下都不允许 AI 写入（客户端本地回填保护）
    private static readonly Regex NameRegex = new(
        @"^basic\.(name|realName)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    // 编辑器用月份选择器（type="month"）的字段：只接受 YYYY-MM
    private static readonly Regex MonthFieldRegex = new(
        @"^(?:basic\.birthday|(?:works|educations|projects)\[[0-9]+\]\.(?:start|end))$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// 某个值是否确实出现在用户说过的话里（防 AI 编造）。
    /// 时间类值放宽：用户写「2023年3月」而 AI 写「2023-03」也要认。
    /// </summary>
    public static bool AppearsInConversation(string text, string value)
    {
        var v = (value ?? "").Trim();
        if (v.Length == 0) return false;
        if (text.Contains(v)) return true;

        var m = Regex.Match(v, @"([0-9]{2,4})[^0-9]{0,3}([0-9]{1,2})?");
        if (!m.Success) return false;
        var year = m.Groups[1].Value;
        if (!text.Contains(year)) return false;
        if (!m.Groups[2].Success) return true;

        var month = int.Parse(m.Groups[2].Value).ToString();
        if (month == "0") return text.Contains(year);
        // 年份后 4 个字符内出现该月份（允许「年/月/-/.」等分隔，且不误吃 10/11/12 月）
        return Regex.IsMatch(text, $"{year}[^0-9]{{0,4}}0?{month}(?=[^0-9]|$)");
    }

    // -----------------------------------------------------------------------
    // 编造事实检测（只做提示，不阻断）
    // -----------------------------------------------------------------------

    private static readonly Regex FactNumRe = new(@"[0-9]+(?:\.[0-9]+)?%?", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex FactLatinRe = new(@"[A-Za-z][A-Za-z0-9+#.\-]{2,}", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// 找出 after 中出现、但 before 中没有的数字/百分比与拉丁术语。
    /// 局限：中文新技术名词（如「微服务」「灰度发布」）抓不到，只能靠 prompt 约束。
    /// </summary>
    public static List<string> DetectNewFacts(string before, string after)
    {
        var beforeLower = before.ToLowerInvariant();
        var found = new List<string>();

        void Push(string v, HashSet<string> seen)
        {
            if (seen.Contains(v)) return;
            seen.Add(v);
            if (v.Length < 2) return;
            if (beforeLower.Contains(v.ToLowerInvariant())) return;
            found.Add(v);
        }

        var numSeen = Collect(before, FactNumRe);
        foreach (var v in Collect(after, FactNumRe)) Push(v, numSeen);

        var latinSeen = Collect(beforeLower, FactLatinRe);
        foreach (var v in Collect(after, FactLatinRe)) Push(v, latinSeen);

        if (found.Count == 0) return [];
        return [$"可能引入了原文没有的信息：{string.Join("、", found.Take(6))}"];
    }

    private static HashSet<string> Collect(string text, Regex re)
    {
        var set = new HashSet<string>();
        foreach (Match m in re.Matches(text)) set.Add(m.Value);
        return set;
    }

    // -----------------------------------------------------------------------
    // 建议式文字过滤（沿用 modules/ai/analyze.ts stripSuggestionRewrites 的语义）
    // -----------------------------------------------------------------------

    private static readonly Regex[] SuggestionPatterns =
    [
        new(@"^建议"), new(@"^可以"), new(@"^推荐"), new(@"^应该"), new(@"^最好"),
        new(@"需补充"), new(@"需添加"), new(@"请填写"), new(@"请补充"),
    ];

    private static bool LooksLikeSuggestion(string text) =>
        SuggestionPatterns.Any(re => re.IsMatch(text.Trim()));

    // -----------------------------------------------------------------------
    // 时间兜底抽取：AI 漏给 start/end 时，从用户原话里照抄一段区间
    // 只做「抄录」，不做推断（抽不到就留空，卡片仍要求用户手填）
    // -----------------------------------------------------------------------

    // 「2023年3月」「2023年」「2023-03」「2023.3」「2023/03」
    // 刻意不认光秃秃的 2023，避免误抓手机号等长数字里的片段
    private static readonly Regex DateTokenRegex = new(
        @"((?:19|20)[0-9]{2})\s*(?:年\s*([0-9]{1,2})?\s*月?|([-/.])\s*([0-9]{1,2}))",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex NowRegex = new(@"至今|现在|目前|在职", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    // 叙述经历时紧挨日期的提示词（「2021年7月入职」「2023年3月离职」「从2021年开始」），
    // 用于多日期场景判断哪个日期属于本条经历
    private static readonly Regex TimelineKeywordRegex = new(
        @"从|自|入职|加入|任职|开始|实习|工作|在职|毕业|就读|在读|项目|至今|离职|离开|辞职|止",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public sealed record TimelineGuess(string Start, string End);

    // 分句边界：时间只有落在条目名所在的同一分句里，才算这条经历的时间
    private static readonly Regex ClauseBreakRegex = new(@"[，。；、,;.!?！？\n\r\t ]", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static (int Lo, int Hi) ClauseRange(string text, int at)
    {
        var lo = at;
        while (lo > 0 && !ClauseBreakRegex.IsMatch(text[lo - 1].ToString())) lo--;
        var hi = at;
        while (hi < text.Length && !ClauseBreakRegex.IsMatch(text[hi].ToString())) hi++;
        return (lo, hi);
    }

    /// <summary>
    /// 在文本里定位条目名；AI 可能把名字写长（「字节跳动有限公司」vs 用户说的「字节跳动」），
    /// 精确匹配不到时退化为「最长公共片段」，仍不上就返回 -1（说明用户压根没提过这个条目）。
    /// </summary>
    private static int LocateName(string text, string name)
    {
        if (string.IsNullOrEmpty(name)) return -1;
        var at = text.IndexOf(name, StringComparison.Ordinal);
        if (at >= 0) return at;
        for (var len = name.Length - 1; len >= 2; len--)
            for (var i = 0; i + len <= name.Length; i++)
            {
                var hit = text.IndexOf(name.Substring(i, len), StringComparison.Ordinal);
                if (hit >= 0) return hit;
            }
        return -1;
    }

    /// <summary>JS String.prototype.slice 语义（越界截断，start &gt; end 时为空）</summary>
    private static string Slice(string text, int start, int end)
    {
        if (start < 0) start = 0;
        if (start > text.Length) start = text.Length;
        if (end > text.Length) end = text.Length;
        if (end < start) end = start;
        return text.Substring(start, end - start);
    }

    /// <summary>
    /// 从用户原话里兜底抽取一段经历的时间区间。
    /// 顺序：条目名所在分句 → 紧挨「入职/开始/离职」等词的日期 → 全文只有 1~2 个日期才敢用。
    /// 第二个时间点必须紧邻第一个（≤60 字符）才算结束时间，避免把无关日期当结束。
    /// </summary>
    public static TimelineGuess? GuessTimeline(string text, string? anchor = null, bool useKeyword = true)
    {
        if (string.IsNullOrEmpty(text)) return null;

        var hits = new List<(string Raw, int Index)>();
        foreach (Match m in DateTokenRegex.Matches(text)) hits.Add((m.Value.Trim(), m.Index));
        if (hits.Count == 0) return null;

        // ① 条目名（公司/学校/项目名）所在分句里的第一个日期
        (string Raw, int Index)? start = null;
        var name = (anchor ?? "").Trim();
        if (name.Length > 0)
        {
            var at = LocateName(text, name);
            if (at >= 0)
            {
                var (lo, hi) = ClauseRange(text, at);
                var inClause = hits.Where(h => h.Index >= lo && h.Index < hi).ToList();
                if (inClause.Count > 0) start = inClause[0];
                else
                {
                    // 名字单独成句、或与时间分处两句（「字节跳动」「2021年7月入职」）→
                    // 放宽到名字附近的日期，优先取名字之后的（「某某公司 2021年7月-2023年9月」）
                    var near = hits.Where(h => Math.Abs(h.Index - at) <= 60).ToList();
                    var after = near.Where(h => h.Index > at).ToList();
                    var pool = after.Count > 0 ? after : near;
                    if (pool.Count > 0) start = pool[0];
                }
            }
        }
        // ② 紧挨「入职/加入/开始/离职」这类词的日期
        //    仅在条目名能在原话里对上时才用：名字都对不上，说明这条经历用户没提过，
        //    再按关键词抓第一个日期就是在给别的经历乱挂时间。
        if (start is null && useKeyword)
        {
            foreach (var h in hits)
            {
                var around = Slice(text, Math.Max(0, h.Index - 8), h.Index + h.Raw.Length + 8);
                if (TimelineKeywordRegex.IsMatch(around)) { start = h; break; }
            }
        }
        // ③ 全文只有 1~2 个日期才敢用（多了归属不确定，不猜）
        if (start is null)
        {
            if (hits.Count > 2) return null;
            start = hits[0];
        }

        var s = start.Value;
        // 结束时间：起始点之后紧邻（≤60 字符）的下一个日期
        foreach (var h in hits)
            if (h.Index > s.Index && h.Index - s.Index <= 60)
                return new TimelineGuess(s.Raw, h.Raw);

        // 只有一个时间点：紧跟「至今」才当结束时间，否则留空
        var tail = Slice(text, s.Index + s.Raw.Length, s.Index + s.Raw.Length + 8);
        return new TimelineGuess(s.Raw, NowRegex.IsMatch(tail) ? "至今" : "");
    }

    // -----------------------------------------------------------------------
    // append 条目归一化
    // -----------------------------------------------------------------------

    public sealed record NormalizedAppend(ResumeEditItem Item, List<string> Risks, string ItemId);

    private static readonly Regex ToMonthRegex = new(
        @"((?:19|20)[0-9]{2})[^0-9]{0,3}([0-9]{1,2})?", RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// 把各种写法的时间收敛成简历约定的 YYYY-MM。
    /// 「2023年3月」「2023-3」「2023.03」→「2023-03」；只给年份（无月份）返回空串——不替用户编月份。
    /// </summary>
    public static string ToMonth(string v)
    {
        var m = ToMonthRegex.Match(v.Trim());
        if (!m.Success) return "";
        var mm = m.Groups[2].Success ? int.Parse(m.Groups[2].Value) : 0;
        if (mm < 1 || mm > 12) return "";
        return $"{m.Groups[1].Value}-{mm:D2}";
    }

    /// <summary>
    /// 把 AI 给的 append 条目归一化：
    /// - 只保留该 section 的合法字段
    /// - 事实字段（start/end/link）只有用户明确说过的才保留，其余置空由用户补
    /// - AI 漏给时间时，从用户原话里兜底抄一段
    /// - 时间统一成 YYYY-MM（编辑器月份框只认这个格式，「至今」改用 current 布尔表示）
    /// - 生成条目 id
    /// - 对「需在对话原文中出现」的字段给出风险提示
    /// </summary>
    /// <param name="verifyText">用于事实核验的文本（只含用户自己说过的话）</param>
    /// <param name="dateText">用于抽取时间的文本（优先当前这条消息，抽不到再退回 verifyText）</param>
    public static NormalizedAppend? NormalizeAppendItem(
        string section, JsonElement raw, string verifyText = "", string? dateText = null)
    {
        dateText ??= verifyText;
        if (section == ResumeSection.Basic) return null;
        if (raw.ValueKind != JsonValueKind.Object) return null;

        var allowed = SettableFields[section];
        var item = new ResumeEditItem();
        foreach (var key in allowed)
            item.SetField(key, raw.TryGetProperty(key, out var el) && el.ValueKind == JsonValueKind.String
                ? el.GetString()!.Trim()
                : "");
        // 事实字段：用户说过就留下，没说过一律置空（AI 不得编造时间与链接）
        foreach (var key in AppendBlankFacts)
        {
            if (!allowed.Contains(key)) continue;
            var v = item.GetField(key);
            if (v.Length == 0 || !AppearsInConversation(verifyText, v)) item.SetField(key, "");
        }

        // 时间收敛成 YYYY-MM；「至今」不是合法月份，改用 current 布尔（works 支持）
        // 只给到年份（如「2021」）收不动会被清空，交给下面的兜底重新从原话里抄
        foreach (var key in new[] { "start", "end" })
        {
            var v = item.GetField(key);
            if (v.Length == 0) continue;
            if (key == "end" && NowRegex.IsMatch(v))
            {
                if (section == ResumeSection.Works) item.Current = true;
                item.SetField("end", "");
                continue;
            }
            item.SetField(key, ToMonth(v));
        }

        // 收敛后仍没有开始时间 → 从用户原话里兜底抄一段（skills 无时间字段，跳过）
        if (section != ResumeSection.Skills && item.GetField("start").Length == 0)
        {
            var anchor = item.GetField("company");
            if (anchor.Length == 0) anchor = item.GetField("school");
            if (anchor.Length == 0) anchor = item.GetField("name");
            // 条目名在用户原话里能对得上，才允许用「关键词邻近」这条启发式
            var useKeyword = anchor.Length == 0
                || LocateName(dateText, anchor) >= 0
                || LocateName(verifyText, anchor) >= 0;
            var guess = GuessTimeline(dateText, anchor, useKeyword)
                ?? GuessTimeline(verifyText, anchor, useKeyword);
            if (guess is not null)
            {
                var start = ToMonth(guess.Start);
                if (start.Length > 0) item.SetField("start", start);
                if (item.GetField("end").Length == 0)
                {
                    if (NowRegex.IsMatch(guess.End))
                    {
                        if (section == ResumeSection.Works) item.Current = true;
                    }
                    else
                    {
                        var end = ToMonth(guess.End);
                        if (end.Length > 0) item.SetField("end", end);
                    }
                }
            }
        }

        var risks = new List<string>();
        if (AppendVerifyInText.TryGetValue(section, out var verifyKeys))
            foreach (var key in verifyKeys)
            {
                var v = item.GetField(key);
                if (v.Length > 0 && !verifyText.Contains(v))
                    risks.Add($"「{v}」未在对话中出现，请确认真实性");
            }

        return new NormalizedAppend(item, risks, NewItemId());
    }

    /// <summary>返回缺失的必填字段中文名（供卡片表单红字提示）</summary>
    public static List<string> CheckAppendRequired(string section, ResumeEditItem item)
    {
        if (section == ResumeSection.Basic) return [];
        string[] required = AppendRequired.TryGetValue(section, out var r) ? r : [];
        var overrides = SectionFieldOverrides.TryGetValue(section, out var o) ? o : null;
        return required
            .Where(key => item.GetField(key).Trim().Length == 0)
            .Select(key =>
                overrides is not null && overrides.TryGetValue(key, out var ov) ? ov
                : FieldLabels.TryGetValue(key, out var fl) ? fl : key)
            .ToList();
    }

    // -----------------------------------------------------------------------
    // 主校验入口
    // -----------------------------------------------------------------------

    public sealed record ValidateEditsResult(List<ResumeEdit> Edits, List<string> Rejected);

    /// <summary>
    /// 逐条校验 AI 返回的 edits。
    /// 任何一条不过就丢弃该条并把原因放进 rejected（不整体失败，保证对话仍可用）。
    /// </summary>
    /// <param name="userText">用户当前这条消息（抽时间优先用它）</param>
    /// <param name="userConvoText">用户在本会话里说过的全部话（仅 user 角色 + 当前消息），事实核验只用它</param>
    public static ValidateEditsResult ValidateEdits(
        JsonElement raw, ResumeContent content, string userText = "", string? userConvoText = null)
    {
        userConvoText ??= userText;
        var edits = new List<ResumeEdit>();
        var rejected = new List<string>();

        if (raw.ValueKind != JsonValueKind.Array) return new ValidateEditsResult(edits, rejected);

        var i = 0;
        foreach (var entry in raw.EnumerateArray())
        {
            i++;
            var idxLabel = $"第 {i} 条建议";
            if (entry.ValueKind != JsonValueKind.Object)
            {
                rejected.Add($"{idxLabel}：格式不正确");
                continue;
            }

            var opEl = entry.TryGetProperty("op", out var o) ? o : default;
            var op = opEl.ValueKind == JsonValueKind.String ? opEl.GetString() : null;
            var reason = GetJsonString(entry, "reason");
            var aiRisks = GetJsonStringArray(entry, "risks");

            if (op == EditOp.Set)
            {
                // 先归一化再校验：模型可能返回 "Works[0].Description" / "basic.currentstatus" 这类
                // 非规范拼写，不归一化会在下面的 SettableFields 检查处被判「字段不可写入」。
                // 归一化后产出的 edit.Field 也是规范路径，前端可直接定位。
                var field = NormalizeFieldPath(GetJsonString(entry, "field"));
                var parsed = ParseFieldPath(field);
                if (parsed is null)
                {
                    rejected.Add($"{idxLabel}：字段路径无效（{(field.Length > 0 ? field : "空")}）");
                    continue;
                }
                var section = parsed.Section;
                var key = parsed.Key;
                if (key is null)
                {
                    // works / projects 这类容器字段不能整体覆写成文本
                    rejected.Add($"{idxLabel}：不允许整体改写「{SectionLabel(section)}」");
                    continue;
                }
                if (!SettableFields[section].Contains(key))
                {
                    rejected.Add($"{idxLabel}：字段「{key}」不可写入");
                    continue;
                }
                if (section == ResumeSection.Basic)
                {
                    if (parsed.Index is not null)
                    {
                        rejected.Add($"{idxLabel}：基本信息不支持下标");
                        continue;
                    }
                }
                else
                {
                    if (parsed.Index is null)
                    {
                        rejected.Add($"{idxLabel}：缺少条目下标（{field}）");
                        continue;
                    }
                    var count = SectionCount(content, section);
                    if (count is null || parsed.Index.Value >= count.Value)
                    {
                        rejected.Add($"{idxLabel}：条目不存在（{field}）");
                        continue;
                    }
                }
                var after = GetJsonString(entry, "after");
                if (after.Length == 0)
                {
                    rejected.Add($"{idxLabel}：改写内容为空");
                    continue;
                }
                // 月份类字段（出生年月 / 起止时间）编辑器是 type="month"，只认 YYYY-MM；
                // 写入别的格式会在界面上变成空白，这里统一收敛，收不动的直接拒绝并说明原因。
                if (MonthFieldRegex.IsMatch(field))
                {
                    var norm = ToMonth(after);
                    if (norm.Length == 0)
                    {
                        rejected.Add($"{idxLabel}：{BuildFieldLabel(field)} 需要「YYYY-MM」格式的月份（若是至今，请在编辑器里勾选「至今」）");
                        continue;
                    }
                    after = norm;
                }
                if (NameRegex.IsMatch(field))
                {
                    rejected.Add($"{idxLabel}：姓名不允许 AI 改写");
                    continue;
                }
                // 事实字段（时间/链接/联系方式/所在地…）AI 不得改写；
                // 但用户在对话里明确给过的值属于「照抄用户原话」，允许写入，否则用户补充的信息无处落地。
                if (IsNoRewriteField(field) && !AppearsInConversation(userConvoText, after))
                {
                    rejected.Add($"{idxLabel}：{BuildFieldLabel(field)} 属于事实字段，用户未在对话中提供，AI 不能改写");
                    continue;
                }
                if (LooksLikeSuggestion(after))
                {
                    rejected.Add($"{idxLabel}：改写内容像建议而非可替换的正文");
                    continue;
                }
                var before = ReadFieldValue(content, field) ?? "";
                if (after == before.Trim())
                {
                    rejected.Add($"{idxLabel}：内容没有变化");
                    continue;
                }
                var setRisks = new List<string>(aiRisks);
                setRisks.AddRange(DetectNewFacts(before, after));
                edits.Add(new ResumeEdit
                {
                    Op = EditOp.Set,
                    Section = section,
                    Field = field,
                    Label = BuildFieldLabel(field),
                    Before = before,
                    After = after,
                    Reason = reason,
                    Risks = setRisks,
                });
                continue;
            }

            if (op == EditOp.Append)
            {
                var secEl = entry.TryGetProperty("section", out var se) ? se : default;
                var sec = secEl.ValueKind == JsonValueKind.String ? secEl.GetString() : null;
                if (sec is null || !SettableFields.ContainsKey(sec) || sec == ResumeSection.Basic)
                {
                    rejected.Add($"{idxLabel}：不支持新增「{ToJsTextOrEmpty(secEl)}」类型的条目");
                    continue;
                }
                var itemEl = entry.TryGetProperty("item", out var ie) ? ie : default;
                var normalized = NormalizeAppendItem(
                    sec, itemEl, userConvoText, userText.Length > 0 ? userText : userConvoText);
                if (normalized is null)
                {
                    rejected.Add($"{idxLabel}：新条目内容格式不正确");
                    continue;
                }
                if (!normalized.Item.HasContent)
                {
                    rejected.Add($"{idxLabel}：新条目没有任何内容");
                    continue;
                }
                var appendRisks = new List<string>(aiRisks);
                appendRisks.AddRange(normalized.Risks);
                edits.Add(new ResumeEdit
                {
                    Op = EditOp.Append,
                    Section = sec,
                    Label = $"新增{SectionLabel(sec)}",
                    Item = normalized.Item,
                    ItemId = normalized.ItemId,
                    Reason = reason,
                    Risks = appendRisks,
                });
                continue;
            }

            // JS：String(op ?? "空")——op 是字符串时原样（含空串），否则取字面量
            rejected.Add($"{idxLabel}：未知操作类型（{(op is not null ? op : ToJsTextOrEmpty(opEl))}）");
        }

        return new ValidateEditsResult(edits, rejected);
    }

    // -----------------------------------------------------------------------
    // JSON 取值辅助（对齐 JS 的宽松取值：非字符串一律当空串）
    // -----------------------------------------------------------------------

    /// <summary>对象上的字符串属性 → trim；缺失/非字符串 → ""（等价 TS 的 typeof x === "string" ? trim : ""）</summary>
    private static string GetJsonString(JsonElement obj, string prop) =>
        obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()!.Trim()
            : "";

    /// <summary>对象上的字符串数组属性 → 过滤掉非字符串与空串（保留原值不 trim）</summary>
    private static List<string> GetJsonStringArray(JsonElement obj, string prop)
    {
        var list = new List<string>();
        if (obj.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.Array)
            foreach (var item in el.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String && (item.GetString() ?? "").Length > 0)
                    list.Add(item.GetString()!);
        return list;
    }

    /// <summary>模拟 JS 的 `v ?? "空"` / `v || "空"`，仅用于拼报错文案</summary>
    private static string ToJsTextOrEmpty(JsonElement el)
    {
        var s = el.ValueKind switch
        {
            JsonValueKind.String => el.GetString() ?? "",
            JsonValueKind.Number => el.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => "",  // null / undefined / 对象 / 数组：调用处补「空」（这些形态在业务上不会出现）
        };
        return s.Length > 0 ? s : "空";
    }
}