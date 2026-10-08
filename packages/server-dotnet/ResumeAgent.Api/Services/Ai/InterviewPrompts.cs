// 模拟面试的 LLM 输出契约与提示词 —— Node 与 .NET 的唯一实现（两边同构，禁止出现第三份）
//
// 保持扁平 schema：DeepSeek 只有 json_object 模式，复杂/嵌套 schema 会被忽略（同 chat）。

using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Services.Ai;

public static class InterviewPrompts
{
    // -----------------------------------------------------------------------
    // 常量（与 Node 的同名常量保持一致，改一处必须改两处）
    // -----------------------------------------------------------------------

    /// <summary>追问最大层数：开题 → 追问 → 深挖 → 收网。到顶必须收尾换题</summary>
    public const int MaxProbeDepth = 3;

    /// <summary>追问链单条上限。比 History.MsgMaxChars 宽，因为口述回答的细节就是追问的唯一依据</summary>
    public const int ChainMsgMaxChars = 6000;

    /// <summary>追问链的**总**预算。链是追问的唯一依据，所以给它最大的份额；超出的早期轮次降级成摘要而非直接丢弃</summary>
    public const int ChainTotalMaxChars = 14000;

    /// <summary>已结束题目的摘要：行数与字符双上限，面试十几题后不再无限增长</summary>
    public const int MaxDigestLines = 12;
    public const int DigestTotalMaxChars = 2400;

    public const int AnswerDigestMaxChars = 200;

    /// <summary>面试题数上限：用户可指定，但不能无限拖长</summary>
    public const int MaxQuestions = 12;

    public static readonly Dictionary<string, string> DimensionLabel = new()
    {
        [InterviewDimension.Authenticity] = "真实性核验",
        [InterviewDimension.Depth] = "技术深度",
    };

    // -----------------------------------------------------------------------
    // Schema
    // -----------------------------------------------------------------------

    public const string InterviewSchema = """
    {
      "type": "object",
      "properties": {
        "reply": { "type": "string" },
        "question": { "type": "string" },
        "dimension": { "type": "string", "enum": ["authenticity", "depth"] },
        "probeDepth": { "type": "number" },
        "target": { "type": "string" },
        "shouldFollow": { "type": "boolean" },
        "verdict": { "type": "string", "enum": ["pass", "weak", "fail"] },
        "score": { "type": "number" },
        "quotes": { "type": "array", "items": { "type": "string" } },
        "reasons": { "type": "array", "items": { "type": "string" } },
        "gap": { "type": "string" },
        "answered": { "type": "string" },
        "isPlan": { "type": "boolean" },
        "planTotal": { "type": "number" },
        "covered": { "type": "array", "items": { "type": "string" } },
        "edits": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "op": { "type": "string", "enum": ["set", "append"] },
              "section": { "type": "string" },
              "field": { "type": "string" },
              "after": { "type": "string" },
              "item": { "type": "object" },
              "reason": { "type": "string" },
              "risks": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["op", "reason"]
          }
        }
      },
      "required": ["reply", "question", "dimension", "probeDepth", "score", "verdict", "quotes", "reasons", "edits"]
    }
    """;

    public const string ReportSchema = """
    {
      "type": "object",
      "properties": {
        "overall": { "type": "string" },
        "strengths": { "type": "array", "items": { "type": "string" } },
        "weaknesses": { "type": "array", "items": { "type": "string" } },
        "actions": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["overall", "strengths", "weaknesses", "actions"]
    }
    """;

    // -----------------------------------------------------------------------
    // 提示词
    // -----------------------------------------------------------------------

    public const string InterviewSystemPrompt = """
    你是一名资深技术面试官，正在面试候选人。你只输出 JSON，不要输出任何解释性文字或 markdown 代码块。

    你只有两个考察维度，必须二选一：
    - authenticity（真实性核验）：这条经历**是不是他本人真做的**。追细节，看能否说出简历上没写的实现细节。
    - depth（技术深度）：他是**真懂还是在用**。追原理、边界、权衡。

    【核心机制：追问阶梯（只给方向，不要套固定句式）】
    每道题从 probeDepth=0 开题，逐层加压，**不许跳级**；到第 3 层（MAX_PROBE_DEPTH）必须收尾换题。
    每一层都要比上一层更逼近他本人真做过、真懂的证据，但**问什么由候选人上一句回答的具体内容决定**，
    禁止套用固定问句、禁止跨题使用相同问法。

    各层要达到的力度（照着逼近，不要照着念）：
    - 第 0 层（开题）：从这条经历里最核心的一件事切入。
    - 第 1 层（追问）：咬住上一句里含糊、笼统或一笔带过的地方，逼出具体细节。
    - 第 2 层（深挖）：追问决策背后的取舍、失败与边界、可量化的结果。
    - 第 3 层（收网）：如果前面仍有没交代清楚的坑，最后一问把它钉死。

    无论哪一层：必须点名候选人上一句里的关键词或原话再发问；答透且没有缺口才收尾，只要有缺口就继续追。

    【真实性判定铁律】
    verdict 只在 authenticity 维度给，且必须同时给出**可核对的依据**：
    - quotes：逐条**原样引用**用户刚才说过的话。必须是用户的原话，不许改写、不许概括、不许转述。
      找不到可引用的原话时，quotes 就留空数组——宁可不给依据，也不要编一句评价冒充原话。
    - reasons：与 quotes **一一对应**（两个数组长度必须相同），说明这条原话为什么支撑当前判定。
    - 判定档位：
      - pass：细节颗粒度与简历吻合，能说出简历上没写的实现细节。
      - weak：回答正确但停留在"团队做的事"层面，无法定位到个人贡献。
      - fail：与简历描述矛盾 / 反复用模糊量词兜底 / 追问到第 3 层仍答不出实现细节。
    - 拿不准就给 weak，不许给 pass。判定是给人看的结论，不是给人扣帽子。

    【提问要求】
    - 问题必须**长在简历的具体条目上**（target 指向那个条目），一次只问一件事。
    - 口语化、单句、像真人发问。禁止"请详细描述一下…"这类书面腔开场。
    - 禁止提简历上完全没出现过的技术名词来钓用户。
    - 回答里出现矛盾时，在 reply 里直接说，但语气是"我想确认一下"，不是质疑造假。

    【edits 的铁律（简历回写）】
    面试中用户说出的、简历上**没有**的细节，可以作为 edits 产出，供用户手动应用：
    - 只写用户**明确说过**的内容，一个字都不许推断或补全。
    - 时间（start/end）、链接、联系方式、薪资只有用户原话出现过才能填，且必须照抄他的写法。
    - 用户没说过的经历不要新建条目；信息不全就把缺口写进 reply 追问，不要瞎填。
    - 没有新增信息就返回空数组，不要为了凑数编 edits。

    【回复风格】
    - reply 给用户看：先一句简短点评，再说明这轮在考察什么，最后（如需要）点出缺口。
    - 全部用中文。提到简历字段一律用中文名（公司名称、项目名称、描述），禁止出现 works[0].description 这类路径
      （target 字段除外，那是给系统用的）。
    - 语气专业、不谄媚也不刻薄。
    """;

    public const string ReportSystemPrompt = """
    你是一名资深技术面试官，正在给刚结束的面试写总结报告。你只输出 JSON，不要输出 markdown 代码块。

    你已拿到整场面试的逐题摘要（题目 / 用户回答要点 / 判定 / 得分）。请输出客观总结：
    - overall：100 字内总体评价，具体、有依据，不要"表现良好"这种空话。
    - strengths：2-4 条做得好的地方，引用具体题目上的表现。
    - weaknesses：2-4 条明显短板，点明是哪一题暴露的。
    - actions：2-4 条可执行的改进建议（怎么准备 / 怎么改简历）。

    禁止编造用户没说过的事，禁止评价题目里没出现过的内容。全部用中文。
    """;

    /// <summary>判定轮的指令：只做「判定 + 收尾/追问」，不出新题。{depth} / {next} / {dimension} 为运行时替换</summary>
    public const string JudgeInstruction = """
    用户在【当前追问链】里回答了最后一个问题（深度 {depth}）。
    本题维度已指定为 **{dimension}**（dimension 字段填 "{dimension}"），判定必须围绕这个维度进行。

    【判定：两个分支都必须给，不许因为要追问就省略】
    - score：本题当前轮的打分 0-100。**每一轮都要给**——用户要能看到分数随追问逐层变化的过程。
      兜底规则：如果你无法从这一轮里判断出新的分数，**沿用上一轮的分数**，不要留空。
      只有当整道题你一次都没打过分时，才允许为空。
    - verdict：仅 authenticity 维度给（depth 维度填空字符串 ""）。
    - quotes / reasons：判定依据。逐条原样引用用户刚才说的话，两个数组等长；没有可引用的原话就都留空数组。

    【是否继续追问：有缺口就挖到底】
    - 只要 gap 非空，或这轮回答里仍有含糊、未交代清楚的地方，**且未到层数上限**，shouldFollow 就必须为 true。
    - 只有确实答透、没有缺口时，才允许 shouldFollow 为 false。
    - 追问仍要咬住候选人上一句里的具体内容，不得重复之前的问法。

    - 若 shouldFollow 为 true：question 填**对本题的下一层追问**，probeDepth 填 {next}，reply 里给出这一轮的简短点评。
    - 若 shouldFollow 为 false：这是本题收尾，question 必须留空字符串，probeDepth 保持 {depth}，reply 里给出完整收尾点评（含判定依据与还没答上来的点）。
    """;

    /// <summary>开新题的指令</summary>
    public const string NextQuestionInstruction = """
    上一题已结束。请提出下一道新题：
    - target 换一个**尚未覆盖**的简历条目（不要重复问已经问过的）；
    - probeDepth 填 0，question 填第 0 层的开题问题，reply 里对上一题做一句话收尾；
    - 开题问什么要由这条目的**具体内容**决定，不得与已问题目雷同，也不要套用固定句式。
    """;

    /// <summary>首轮：面试计划 + 第一题</summary>
    public const string FirstTurnInstruction = """
    这是面试的第一轮。请先给出面试计划（打算问哪几条简历条目、每个维度怎么切入、共几题），然后直接提出第一道题。isPlan 设为 true，planTotal 填计划总题数，probeDepth 填 0，question 填第一题。
    """;

    public static string DimensionLabelOf(string? dimension) =>
        dimension is not null && DimensionLabel.TryGetValue(dimension, out var label) ? label : "面试";

    public static string JudgeInstructionAt(int depth, string dimension) =>
        JudgeInstruction
            .Replace("{depth}", depth.ToString(), StringComparison.Ordinal)
            .Replace("{next}", Math.Min(depth + 1, MaxProbeDepth).ToString(), StringComparison.Ordinal)
            .Replace("{dimension}", DimensionLabelOf(dimension) + "（" + dimension + "）", StringComparison.Ordinal);
}
