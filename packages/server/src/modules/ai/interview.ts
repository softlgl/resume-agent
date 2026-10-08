// AI 模拟面试模块 —— Node 与 .NET 的唯一实现（两边同构，禁止出现第三份）
//
// 与 modules/ai/chat.ts 的三处刻意差异（这是面试功能能否成立的前提，不要图省事"简化"掉）：
//
// 1. 简历不每轮全量发送。追问时只发 meta.target 指向的那一条——追问必须聚焦到具体条目上才有杀伤力，
//    全量简历反而会让模型去问泛泛的"介绍一下你的项目"。只有开新题时才给全量（它需要知道还有什么可问）。
// 2. 历史不走 core/history.ts 的 A 视图（getHistoryForLLM）。面试必须按 questionId 分组：
//    - 当前追问链（同一 questionId）逐字保留、不截断——用户口述回答动辄上千字，
//      而细节是追问的唯一依据，A 视图的 HISTORY_MSG_MAX_CHARS=2000 会直接让它失聪；
//    - 已结束的题目压成一行摘要，保留"问过什么"以避免重复提问。
//    依据（meta.probeDepth / meta.dimension）就存在 meta 列里，被截断就丢依据了，
//    这正是 core/history.ts 顶部"注释 C 读取（不走本文件）"所说的那件事。
// 3. 产出除点评外还带 questionId / probeDepth / verdict，进 meta 列供前端渲染与报告聚合。
//
// 【状态机：为什么一次 LLM 调用只做一件事】
// 一条 assistant 消息只能带一个 questionId。如果让模型在"收尾旧题"的同时"开出新题"，
// 这条消息归到哪一组都不对——归新组则旧题丢失判定（报告算分错），归旧组则新题没有 questionId，
// 分组断裂、追问链串不起来。所以强制拆成两次调用：
//   回答后判定 → 若该追问：1 次调用出一条「追问」；
//                 若该收尾：1 次调用出一条「收尾」（isClosing，question 为空）+ 再 1 次调用出一条「新题」。
// 换题频率低（每题一次），多这一次调用换来状态机无歧义，值。
//
// 设计约束（沿用 chat.ts 的铁律）：本模块不提供任何"直接改简历字段"的接口。
// 追问中挖出的、简历上没写的细节以 edits 卡片产出，必须用户点「应用」才落库——
// 面试是用户主动表达，AI 不得替他确认事实，更不得自动回写。

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type {
  ChatMessageRecord,
  DimensionScore,
  InterviewAction,
  InterviewDimension,
  InterviewQuestionSummary,
  InterviewReport,
  InterviewRoundScore,
  InterviewTurnMeta,
  InterviewVerdict,
  ResumeContent,
  ResumeEdit,
} from "@resume-agent/shared";
import { chatStream, getLLMConfig, isLLMAvailable, parseJSON } from "./core/llm.js";
import type { ChatMessage } from "./core/llm.js";
import { contextCharBudget } from "./core/history.js";
import { sanitizeContent } from "./core/prompts.js";
import { recordCall } from "./core/call-log.js";
import { buildFieldLabel, parseFieldPath, validateEdits } from "../../services/resume-edit.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 追问最大层数：开题 → 追问 → 深挖 → 收网。到顶必须收尾换题，否则审问不散 */
const MAX_PROBE_DEPTH = 3;

/** 追问链单条上限。比 history.ts 的 2000 宽，因为口述回答的细节就是依据（见文件头 2.） */
const CHAIN_MSG_MAX_CHARS = 6000;

/** 追问链的**总**预算。链是追问的唯一依据，所以给它最大的份额；超出的早期轮次降级成摘要而非直接丢弃 */
const CHAIN_TOTAL_MAX_CHARS = 14000;

/** 已结束题目的摘要：行数与字符双上限，面试十几题后不再无限增长 */
const MAX_DIGEST_LINES = 12;
const DIGEST_TOTAL_MAX_CHARS = 2400;

/** 面试题数上限：用户可指定，但不能无限拖长 */
const MAX_QUESTIONS = 12;

// ---------------------------------------------------------------------------
// 过程日志：方便对着状态机观察每一回合怎么走。
//   AI_DEBUG=0 关闭；默认输出关键节点；AI_DEBUG=2 追加更细的字段。
//   只打状态/计数/字段路径，不打简历正文与用户回答原文（避免把隐私刷进日志）。
// ---------------------------------------------------------------------------
const AI_DEBUG = process.env.AI_DEBUG !== "0";
const AI_DEBUG_VERBOSE = process.env.AI_DEBUG === "2";
/** 关键节点日志（每条回合只有几条） */
function ilog(step: string, data?: Record<string, unknown>) {
  if (AI_DEBUG) console.log(`[AI-INTERVIEW] ${step}`, data ? JSON.stringify(data) : "");
}
/** 细粒度日志：仅 AI_DEBUG=2 时输出 */
function idbg(step: string, data?: Record<string, unknown>) {
  if (AI_DEBUG_VERBOSE) console.log(`[AI-INTERVIEW·debug] ${step}`, data ? JSON.stringify(data) : "");
}
/** 计时：返回一个取已过毫秒数的闭包 */
function timer() {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

/** 摘要行里用户回答要点的截断长度 */
const ANSWER_DIGEST_MAX_CHARS = 200;

const DIMENSION_LABEL: Record<InterviewDimension, string> = {
  authenticity: "真实性核验",
  depth: "技术深度",
};

// ---------------------------------------------------------------------------
// LLM 输出契约
// 保持扁平：DeepSeek 只有 json_object 模式，复杂/嵌套 schema 会被忽略（同 chat.ts）
// ---------------------------------------------------------------------------

const INTERVIEW_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" }, // 点评 / 收尾说明（用户可见）
    question: { type: "string" }, // 本轮提出的问题（用户可见）；收尾轮留空
    dimension: { type: "string", enum: ["authenticity", "depth"] },
    probeDepth: { type: "number" }, // 0 开题 / 1 追问 / 2 深挖
    target: { type: "string" }, // 考察的简历条目路径，如 "works[0]"
    shouldFollow: { type: "boolean" }, // 是否继续追问本题
    verdict: { type: "string", enum: ["pass", "weak", "fail"] }, // 仅 authenticity 维度
    score: { type: "number" }, // 本题 0-100
    quotes: { type: "array", items: { type: "string" } }, // 判定依据·用户原话（逐字引用）
    reasons: { type: "array", items: { type: "string" } }, // 判定依据·与 quotes 一一对应的理由
    gap: { type: "string" }, // 没答出来的点，直接驱动下一轮追问
    answered: { type: "string" }, // 对用户本轮回答的要点概括（≤120 字）
    isPlan: { type: "boolean" }, // 会话首条：面试计划（含第一题）
    planTotal: { type: "number" }, // isPlan：计划总题数
    covered: { type: "array", items: { type: "string" } }, // 已覆盖的简历条目路径
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["set", "append"] },
          section: { type: "string" },
          field: { type: "string" },
          after: { type: "string" },
          item: { type: "object" },
          reason: { type: "string" },
          risks: { type: "array", items: { type: "string" } },
        },
        required: ["op", "reason"],
      },
    },
  },
  required: ["reply", "question", "dimension", "probeDepth", "score", "verdict", "quotes", "reasons", "edits"],
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    overall: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
  },
  required: ["overall", "strengths", "weaknesses", "actions"],
};

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const INTERVIEW_SYSTEM_PROMPT = `你是一名资深技术面试官，正在面试候选人。你只输出 JSON，不要输出任何解释性文字或 markdown 代码块。

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
- 语气专业、不谄媚也不刻薄。`;

const REPORT_SYSTEM_PROMPT = `你是一名资深技术面试官，正在给刚结束的面试写总结报告。你只输出 JSON，不要输出 markdown 代码块。

你已拿到整场面试的逐题摘要（题目 / 用户回答要点 / 判定 / 得分）。请输出客观总结：
- overall：100 字内总体评价，具体、有依据，不要"表现良好"这种空话。
- strengths：2-4 条做得好的地方，引用具体题目上的表现。
- weaknesses：2-4 条明显短板，点明是哪一题暴露的。
- actions：2-4 条可执行的改进建议（怎么准备 / 怎么改简历）。

禁止编造用户没说过的事，禁止评价题目里没出现过的内容。全部用中文。`;

/** 判定轮的指令：只做「判定 + 收尾/追问」，不出新题。{depth} / {next} / {dimension} 为运行时替换 */
const JUDGE_INSTRUCTION = `用户在【当前追问链】里回答了最后一个问题（深度 {depth}）。
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
- 若 shouldFollow 为 false：这是本题收尾，question 必须留空字符串，probeDepth 保持 {depth}，reply 里给出完整收尾点评（含判定依据与还没答上来的点）。`;

/** 开新题的指令 */
const NEXT_QUESTION_INSTRUCTION = `上一题已结束。请提出下一道新题：
- target 换一个**尚未覆盖**的简历条目（不要重复问已经问过的）；
- probeDepth 填 0，question 填第 0 层的开题问题，reply 里对上一题做一句话收尾；
- 开题问什么要由这条目的**具体内容**决定，不得与已问题目雷同，也不要套用固定句式。`;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** SSE result 里的消息必须是完整记录：前端直接把它 push 进消息流，缺 content/createdAt 会渲染成空白 */
function toMessageRecord(r: RawRow): ChatMessageRecord {
  return {
    id: r.id,
    sessionId: r.sessionId,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    edits: (r.edits as ResumeEdit[] | null) ?? null,
    appliedIndexes: Array.isArray(r.appliedIndexes) ? (r.appliedIndexes as number[]) : [],
    reasoning: r.reasoning ?? null,
    meta: parseMeta(r.meta),
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

function parseMeta(raw: unknown): InterviewTurnMeta | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as InterviewTurnMeta;
}

/**
 * 维度交替：模型天然倾向整场都用同一个维度（实测 4 题全是 authenticity，
 * 报告里「技术深度」永远是 —）。所以维度改由服务端按已出题数强制交替，
 * 不再信任模型自选的 dimension。模型只负责在给定维度下出题。
 */
function nextDimension(asked: string[]): InterviewDimension {
  let a = 0;
  let d = 0;
  for (const x of asked) {
    if (x === "depth") d++;
    else if (x === "authenticity") a++;
  }
  return d < a ? "depth" : "authenticity";
}

/**
 * 换题时挑考察条目。
 * 优先尊重模型选的 target（允许隔题复用同一条目——不同维度问同一个项目是合理的），
 * 但**连续两题撞同一个条目**时强制换一个，否则会出现「刚问完又问一遍」。
 */
function pickNextTarget(
  content: ResumeContent,
  modelTarget: string | null,
  lastTarget: string | null,
  covered: string[]
): string | null {
  if (modelTarget && modelTarget !== lastTarget) return modelTarget;
  if (modelTarget && !lastTarget) return modelTarget;
  return listAskableItems(content).find((a) => a.path !== lastTarget && !covered.includes(a.path))?.path ?? modelTarget;
}

/**
 * 取**当前题**（最后一组）开题消息定的维度；判定轮必须沿用它，避免同一题中途换维度导致统计错位。
 * 注意：首题的开题消息带 isPlan，它正是 q1 的权威维度来源，所以这里**不能**跳过 isPlan，
 * 只需排除 report。否则会退化成"取第一个非 plan 题组"，从第 3 题起读到上一题的维度。
 */
function questionDimensionOf(rows: RawRow[]): InterviewDimension | null {
  const groups = groupByQuestion(rows);
  const current = groups[groups.length - 1];
  if (!current) return null;
  const opening = current.rows.find((r) => r.role === "assistant" && !parseMeta(r.meta)?.isReport);
  const m = parseMeta(opening?.meta);
  return m ? clampDimension(m.dimension) : null;
}

function clampDimension(v: unknown): InterviewDimension {
  return v === "depth" ? "depth" : "authenticity";
}

function clampVerdict(v: unknown): InterviewVerdict {
  return v === "fail" ? "fail" : v === "weak" ? "weak" : "pass";
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function cleanStrArray(v: unknown, max = 5): string[] {
  return Array.isArray(v)
    ? v.filter((e: unknown): e is string => typeof e === "string" && !!e.trim()).slice(0, max)
    : [];
}

/**
 * 取判定依据的配对数组：quotes（用户原话）与 reasons（理由）必须等长。
 * 模型经常给出不等长（甚至只给一边），这里以 min 长度截断对齐——
 * 宁可少给一条依据，也绝不让前端出现「有理由没原话」的悬空项。
 */
function cleanVerdictBasis(parsed: any): { quotes: string[]; reasons: string[] } {
  const quotes = cleanStrArray(parsed.quotes).map((q) => q.trim());
  const reasons = cleanStrArray(parsed.reasons).map((r) => r.trim());
  const n = Math.min(quotes.length, reasons.length);
  return { quotes: quotes.slice(0, n), reasons: reasons.slice(0, n) };
}

function cleanText(v: unknown, max = 200): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : undefined;
}

/** target 只接受 section[index]（不带字段名、不接受整段），防止模型编出不存在的位置或粒度太粗 */
function normalizeTarget(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const parsed = parseFieldPath(v.trim());
  if (!parsed || parsed.key !== null || parsed.index === null) return null;
  return `${parsed.section}[${parsed.index}]`;
}

/** 取出本轮要考察的那一条简历原文 */
function sliceTarget(content: ResumeContent, target: string | null): { label: string; value: unknown } | null {
  if (!target) return null;
  const parsed = parseFieldPath(target);
  if (!parsed || parsed.index === null) return null;
  const list = content[parsed.section] as unknown as unknown[] | undefined;
  const item = list?.[parsed.index];
  return item ? { label: buildFieldLabel(target), value: item } : null;
}

/** 该简历到底有哪些条目可问（供「请换一条未覆盖的」有据可依） */
function listAskableItems(content: ResumeContent): { path: string; label: string }[] {
  const out: { path: string; label: string }[] = [];
  for (const key of ["works", "projects", "educations"] as const) {
    const list = content[key];
    if (!Array.isArray(list)) continue;
    list.forEach((_, i) => {
      const path = `${key}[${i}]`;
      out.push({ path, label: buildFieldLabel(path) });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 历史装配（D 视图：面试专用，见文件头 2. 与 core/history.ts 的 C 读取约定）
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  edits: unknown;
  appliedIndexes: unknown;
  reasoning: string | null;
  meta: unknown;
  createdAt: Date;
}

/** 按 questionId 把消息序列切成「一道题 = 一个分组」，保持出现顺序 */
function groupByQuestion(rows: RawRow[]): { questionId: string; rows: RawRow[] }[] {
  const groups: { questionId: string; rows: RawRow[] }[] = [];
  for (const r of rows) {
    const qid = parseMeta(r.meta)?.questionId;
    if (!qid || qid === "report") continue; // plan / report 不进题组
    const last = groups[groups.length - 1];
    if (last && last.questionId === qid) last.rows.push(r);
    else groups.push({ questionId: qid, rows: [r] });
  }
  return groups;
}

/** 一道已结束的题压成一行摘要：问什么 / 答了什么要点 / 判定如何 */
function summarizeGroup(group: { questionId: string; rows: RawRow[] }): string {
  return summarizeRows(group.rows);
}

/** 摘要生成（可只传入一道题的部分轮次，用于链超预算时把早期轮次降级） */
function summarizeRows(rows: RawRow[]): string {
  const assistants = rows.filter((r) => r.role === "assistant");
  const first = assistants[0];
  const last = assistants[assistants.length - 1];
  const fm = parseMeta(first?.meta);
  const lm = parseMeta(last?.meta);
  const question = (first?.content ?? "").replace(/\s+/g, " ").slice(0, 90);
  // 回答要点取该题最后一条 assistant 的 answered（模型对用户本轮回答的概括）
  const answered =
    cleanText(lm?.answered, ANSWER_DIGEST_MAX_CHARS) ??
    cleanText(rows.find((r) => r.role === "user")?.content, ANSWER_DIGEST_MAX_CHARS) ??
    "（未作答）";
  const rounds = rows.filter((r) => r.role === "user").length;
  const depth = rows.length === 0 ? 0 : Math.max(...rows.map((r) => Number(parseMeta(r.meta)?.probeDepth ?? 0)));
  const verdict = lm?.verdict ? `判定 ${lm.verdict}` : "";
  const score = typeof lm?.score === "number" ? `${lm.score} 分` : "未评分";
  const gap = lm?.gap ? `｜缺口：${lm.gap.slice(0, 60)}` : "";
  const dim = DIMENSION_LABEL[fm?.dimension ?? "authenticity"];
  return rows.some((r) => r.role === "user")
    ? `- [${dim}·${fm?.targetLabel ?? "未定位"}] 问：${question} ｜答：${answered} ｜${verdict}${score}${gap}（追问 ${depth} 层，共 ${rounds} 轮）`
    : `- [${dim}·${fm?.targetLabel ?? "未定位"}] 问：${question} ｜（早期追问内容已按预算省略）`;
}

interface AssembledHistory {
  chain: ChatMessage[]; // 当前追问链，逐字
  digest: string[]; // 已结束题目的摘要行
  covered: string[]; // 已覆盖的简历条目（全量并集）
  plan: InterviewTurnMeta | null;
}

/** 面试历史的预算拆分：链拿大头（追问依据），摘要封顶（防线性增长） */
function historyBudgets() {
  const total = contextCharBudget();
  return {
    chain: Math.min(CHAIN_TOTAL_MAX_CHARS, Math.floor(total * 0.4)),
    digest: Math.min(DIGEST_TOTAL_MAX_CHARS, Math.floor(total * 0.1)),
  };
}

/** 摘要行双封顶：先按行数从旧到新丢，再按字符总量从旧到新丢 */
function trimDigest(lines: string[], maxChars: number): string[] {
  let out = lines.slice(-MAX_DIGEST_LINES);
  let used = 0;
  const kept: string[] = [];
  for (let i = out.length - 1; i >= 0; i--) {
    used += out[i].length;
    if (used > maxChars) break;
    kept.unshift(out[i]);
  }
  out = kept;
  return out;
}

/**
 * 装配面试历史。
 * @param currentQuestionId 当前追问链的 questionId；null 表示不保留任何链（用于「结束面试」/「换题」）
 * @param budgets 链与摘要的字符预算，见 historyBudgets
 */
function buildInterviewHistory(
  rows: RawRow[],
  currentQuestionId: string | null,
  budgets = historyBudgets()
): AssembledHistory {
  const out: AssembledHistory = { chain: [], digest: [], covered: [], plan: null };
  const seen = new Set<string>();

  for (const r of rows) {
    const m = parseMeta(r.meta);
    if (m?.isPlan) {
      out.plan = m;
      continue;
    }
    if (m?.isReport) continue;
    if (m?.target && !seen.has(m.target)) {
      seen.add(m.target);
      out.covered.push(m.target);
    }
  }

  const groups = groupByQuestion(rows);
  const current = currentQuestionId ? groups.find((g) => g.questionId === currentQuestionId) : undefined;

  if (current) {
    // 当前链：从最新往回累加，超预算的早期轮次降级成摘要（不直接丢弃，否则会断掉判定依据）
    const kept: RawRow[] = [];
    const dropped: RawRow[] = [];
    let used = 0;
    for (let i = current.rows.length - 1; i >= 0; i--) {
      const r = current.rows[i];
      const c = clampChain(r.content);
      if (used + c.length > budgets.chain && kept.length > 0) {
        dropped.unshift(r);
        continue;
      }
      kept.unshift(r);
      used += c.length;
    }
    out.chain = kept.map((r) => ({
      role: r.role === "assistant" ? "assistant" : "user",
      content: clampChain(r.content),
    }));
    if (dropped.length) out.digest.push(summarizeRows(dropped));
  }

  for (const g of groups) {
    if (currentQuestionId && g.questionId === currentQuestionId) continue;
    out.digest.push(summarizeGroup(g));
  }
  out.digest = trimDigest(out.digest, budgets.digest);
  return out;
}

function clampChain(content: string): string {
  return content.length > CHAIN_MSG_MAX_CHARS
    ? `${content.slice(0, CHAIN_MSG_MAX_CHARS)}…（已截断）`
    : content;
}

/** 追问深度的合法值：0 | 1 | 2。任何非有限数/负数/超界一律归 0 —— 绝不让 NaN 写进 meta 污染后续轮次 */
function safeDepth(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_PROBE_DEPTH);
}

/** 当前正在追问的 questionId 与该题已到达的深度 */
function currentTurnState(rows: RawRow[]): { questionId: string | null; depth: number } {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role !== "assistant") continue;
    const m = parseMeta(rows[i].meta);
    if (m && !m.isReport && m.questionId) {
      return { questionId: m.questionId, depth: safeDepth(m.probeDepth) };
    }
  }
  // 找不到任何在追问的题（例如上一轮建会话时 LLM 失败，残缺会话里只有用户消息）：
  // 归 0 让本轮从开题层重新开始，而不是被 -1 拖进 NaN
  return { questionId: null, depth: 0 };
}

/** 最近一次非收尾消息的 target（追问时不换考察对象） */
function lastTargetOf(rows: RawRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role !== "assistant") continue;
    const m = parseMeta(rows[i].meta);
    if (m && !m.isReport && m.target) return m.target;
  }
  return null;
}

// ---------------------------------------------------------------------------
// User message 拼装
// ---------------------------------------------------------------------------

/**
 * 兜底探针：组装完 prompt 后估算总量，超出「上下文 - 输出预留」就打 warn。
 * 不阻断请求——预算分配已经保证不会真爆，这条只是让你能发现哪些「模型 × 简历」组合顶到了墙。
 */
function assertWithinContext(messages: ChatMessage[], label: string) {
  const cfg = getLLMConfig();
  const maxContext = cfg?.maxContext ?? 32768;
  const maxOutput = cfg?.maxOutput ?? 4096;
  const total = messages.reduce((a, m) => a + m.content.length, 0);
  const limit = Math.max(1024, maxContext - maxOutput);
  if (total > limit) {
    console.warn(
      `[AI-INTERVIEW] ${label} prompt 约 ${total} 字符，可能超出 ${cfg?.provider ?? "?"}/${cfg?.model ?? "?"} 的可用上下文 ${limit}（maxContext ${maxContext} - maxOutput ${maxOutput}）`
    );
  }
}

/** 递归截断长字符串——保证裁剪后仍是合法 JSON（硬切 JSON 会让模型读到半截结构） */
function truncateStrings(value: any, max: number): any {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateStrings(v, max);
    return out;
  }
  return value;
}

/** 渐进裁剪简历：每轮都重新 stringify，输出永远是合法 JSON */
function fitResumeJson(content: ResumeContent, budget: number): { json: string; trimmed: boolean } {
  const sanitized = sanitizeContent(content);
  const full = JSON.stringify(sanitized, null, 2);
  if (full.length <= budget) return { json: full, trimmed: false };

  // 逐级减少每个 section 保留的条目数
  for (const keep of [3, 1]) {
    const c = compactResume(sanitized, keep);
    const json = JSON.stringify(c, null, 2);
    if (json.length <= budget) return { json, trimmed: true };
  }
  // 仍然超：逐级截断长文本字段（经验上到这里已经远小于预算）
  for (const chars of [400, 120]) {
    const json = JSON.stringify(truncateStrings(sanitized, chars), null, 2);
    if (json.length <= budget) return { json, trimmed: true };
  }
  return { json: JSON.stringify(truncateStrings(sanitized, 40), null, 2), trimmed: true };
}

/** 简历精简版：每 section 只留关键字段与前 keep 条（口径对齐 chat.ts 的 compactResume） */
function compactResume(content: any, keep: number) {
  const cut = <T,>(arr: T[] | undefined) => (Array.isArray(arr) ? arr.slice(0, keep) : []);
  return {
    basic: {
      name: content?.basic?.name,
      title: content?.basic?.title,
      summary: content?.basic?.summary,
      currentStatus: content?.basic?.currentStatus,
      workYears: content?.basic?.workYears,
    },
    works: cut(content?.works).map((w: any) => ({
      company: w?.company,
      role: w?.role,
      start: w?.start,
      end: w?.end,
      description: w?.description,
    })),
    projects: cut(content?.projects).map((p: any) => ({
      name: p?.name,
      role: p?.role,
      description: p?.description,
    })),
    skills: cut(content?.skills).map((s: any) => ({ category: s?.category, items: s?.items })),
  };
}

function buildResumeBlock(content: ResumeContent): string {
  const { json, trimmed } = fitResumeJson(content, Math.floor(contextCharBudget() * 0.35));
  return `【候选人简历（敏感信息已脱敏${trimmed ? "，篇幅已精简" : ""}）】\n\`\`\`json\n${json}\n\`\`\``;
}

function buildInterviewUserContent(opts: {
  content: ResumeContent;
  target: string | null;
  history: AssembledHistory;
  /** 判定轮看追问链；开新题轮不需要链，只需要摘要 */
  withChain: boolean;
  instruction: string;
  userText?: string;
  targetRole: string | null;
}): string {
  const parts: string[] = [];

  // 简历：追问轮只给本轮那一条，开新题轮给全量（它要知道还有什么可问）
  const slice = opts.withChain ? sliceTarget(opts.content, opts.target) : null;
  if (slice) {
    parts.push(
      `【本轮考察的简历条目：${slice.label}】\n\`\`\`json\n${JSON.stringify(sanitizeContent(slice.value), null, 2)}\n\`\`\``
    );
  } else {
    parts.push(buildResumeBlock(opts.content));
  }

  if (opts.targetRole?.trim()) parts.push(`【面试岗位】\n${opts.targetRole.trim()}`);

  const askable = listAskableItems(opts.content);
  parts.push(
    `【可考察的简历条目（target 只能取这些值之一）】\n${askable.map((a) => `${a.path} = ${a.label}`).join("\n") || "（无）"}`
  );

  if (opts.history.plan) {
    parts.push(
      `【你此前给出的面试计划】共 ${opts.history.plan.questionCount ?? "?"} 题，已覆盖：${opts.history.covered.join("、") || "（无）"}`
    );
  }

  if (opts.history.digest.length) {
    parts.push(`【已问过的题（摘要，不要重复提问）】\n${opts.history.digest.join("\n")}`);
  }

  if (opts.history.chain.length) {
    parts.push(`【当前追问链（逐字原文，用户的回答细节是判定的唯一依据）】`);
    for (const m of opts.history.chain) {
      parts.push(`${m.role === "assistant" ? "面试官" : "候选人"}：${m.content}`);
    }
  }

  if (opts.history.covered.length) {
    parts.push(
      `【已覆盖的简历条目】${opts.history.covered.join("、")}（开新题时必须换一条没覆盖过的）`
    );
  }

  if (opts.userText) parts.push(`【用户本轮回答】\n${opts.userText}`);
  parts.push(`【本轮指令】\n${opts.instruction}`);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// 报告：分数纯本地聚合（必须可复现，不让模型自己给自己打分），文字总结才交给 LLM
// ---------------------------------------------------------------------------

function emptyDimensionScore(): DimensionScore {
  return { score: 0, samples: 0, weakest: null };
}

function aggregateReport(
  sessionId: string,
  rows: RawRow[],
  planTotal: number,
  finished: boolean
): InterviewReport {
  const questions: InterviewQuestionSummary[] = [];
  const buckets: Record<InterviewDimension, number[]> = { authenticity: [], depth: [] };
  const weakest: Record<InterviewDimension, { score: number; text: string } | null> = {
    authenticity: null,
    depth: null,
  };

  for (const g of groupByQuestion(rows)) {
    const assistants = g.rows.filter((r) => r.role === "assistant");
    const first = assistants[0];
    const last = assistants[assistants.length - 1];
    const fm = parseMeta(first?.meta);
    const lm = parseMeta(last?.meta);
    // 注意：isPlan 的消息**不能**用来跳过整题——面试计划与「第 1 题开题」是同一条消息
    // （建会话时合成一次调用，见 openNewQuestion 上方的说明），跳过它就等于丢掉第 1 题全部三轮的分数。
    // report 消息由 groupByQuestion 按 questionId === "report" 排除，这里再兜一层。
    if (!fm || fm.isReport) continue;

    // 判定依据要沿用「最后一次非空」，不能只看最后一条 assistant。
    // 模型在收尾轮（最深一层）通常认为已经判定过、不再重复引用原话，
    // 若只取 lm 就会出现「分数还在、依据却丢了」的情况（score 有 fallback，依据没有）。
    const basisMsg = [...assistants].reverse().find((r) => (parseMeta(r.meta)?.quotes?.length ?? 0) > 0);
    const bm = parseMeta(basisMsg?.meta);

    // 以该题最后一次判定/评分为准（追问过程会修正初判）
    const score = typeof lm?.score === "number" ? lm.score : typeof fm.score === "number" ? fm.score : null;
    const verdict = lm?.verdict ?? fm.verdict;
    // 用户从未作答过这道题（点「换一题」跳过）——不参与均分，报告里单独标注
    const skipped = !g.rows.some((r) => r.role === "user");

    // 逐轮分数轨迹：每条判定轮都收进来。
    // 模型偶尔漏给 score —— 这时**照样要把这一轮记进轨迹**（score 留空），
    // 否则「模型没打分」这件事在界面上就彻底看不见了，用户只会以为功能没实现。
    const rounds: InterviewRoundScore[] = assistants
      .map((r) => parseMeta(r.meta))
      .filter(
        (m): m is InterviewTurnMeta =>
          !!m && !m.isPlan && !m.isReport && (typeof m.score === "number" || !!m.verdict || !!m.quotes?.length)
      )
      .map((m) => ({
        depth: m.probeDepth ?? 0,
        ...(typeof m.score === "number" ? { score: clampScore(m.score) } : {}),
        ...(m.verdict ? { verdict: m.verdict } : {}),
      }))
      .sort((a, b) => a.depth - b.depth);

    if (score !== null) {
      buckets[fm.dimension].push(score);
      const cur = weakest[fm.dimension];
      if (!cur || score < cur.score) {
        weakest[fm.dimension] = { score, text: (first?.content ?? "").replace(/\s+/g, " ").slice(0, 80) };
      }
    }

    questions.push({
      questionId: g.questionId,
      dimension: fm.dimension,
      ...(fm.target ? { target: fm.target } : {}),
      ...(fm.targetLabel ? { targetLabel: fm.targetLabel } : {}),
      question: (first?.content ?? "").trim(),
      probeDepth: Math.max(...g.rows.map((r) => Number(parseMeta(r.meta)?.probeDepth ?? 0))),
      ...(verdict ? { verdict } : {}),
      ...(score !== null ? { score } : {}),
      // 逐轮轨迹：每一轮的判定都摆出来，别只给最终分
      ...(rounds.length ? { rounds } : {}),
      ...(bm?.quotes?.length ? { quotes: bm.quotes } : {}),
      ...(bm?.reasons?.length ? { reasons: bm.reasons } : {}),
      ...(lm?.gap ? { gap: lm.gap } : bm?.gap ? { gap: bm.gap } : {}),
      ...(skipped ? { skipped: true } : {}),
    });
  }

  const toDim = (arr: number[], d: InterviewDimension): DimensionScore => {
    if (!arr.length) return emptyDimensionScore();
    return {
      score: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
      samples: arr.length,
      weakest: weakest[d]?.text ?? null,
    };
  };

  const all = [...buckets.authenticity, ...buckets.depth];
  return {
    sessionId,
    questionCount: questions.length,
    answeredCount: questions.filter((q) => !q.skipped).length,
    avgScore: all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length) : 0,
    authenticity: toDim(buckets.authenticity, "authenticity"),
    depth: toDim(buckets.depth, "depth"),
    planTotal,
    finished,
    questions,
  };
}

/** 报告正文：LLM 写文字总结；没配模型或调用失败时用本地数据兜底，保证一定有报告 */
async function buildReportText(
  history: AssembledHistory,
  report: InterviewReport,
  onReasoning?: (delta: string) => void
): Promise<string> {
  const head =
    `## 面试报告\n\n` +
    `**综合 ${report.avgScore} 分** ｜ 真实性核验 ${report.authenticity.score} 分（${report.authenticity.samples} 题）` +
    ` ｜ 技术深度 ${report.depth.score} 分（${report.depth.samples} 题）` +
    ` ｜ 作答 ${report.answeredCount} 题` +
    (report.questionCount > report.answeredCount ? `（另跳过 ${report.questionCount - report.answeredCount} 题未作答，不计分）` : "");

  const fallback =
    head +
    (report.questions.length
      ? `\n\n### 逐题要点\n${report.questions
          .map(
            (q, i) =>
              `${i + 1}. [${DIMENSION_LABEL[q.dimension]}${q.targetLabel ? ` · ${q.targetLabel}` : ""}] ${q.question.replace(/\s+/g, " ").slice(0, 100)}` +
              (q.skipped
                ? ` —— **已跳过，未作答，不计分**`
                : `${q.verdict ? ` —— ${q.verdict}` : ""}${typeof q.score === "number" ? ` ${q.score} 分` : ""}` +
                  `${q.rounds && q.rounds.length > 1 ? `\n   分数轨迹：${q.rounds.map((r) => r.score ?? "—").join(" → ")}` : ""}`) +
              `${q.gap ? `\n   缺口：${q.gap}` : ""}`
          )
          .join("\n")}`
      : "\n\n本场没有有效作答记录。") +
    `\n\n> 模型未生成文字总结（未配置模型或调用失败），以上为本地聚合结果。`;

  if (!isLLMAvailable()) return fallback;

  const digest = trimDigest(history.digest, historyBudgets().digest).join("\n") || "（无有效记录）";
  const messages: ChatMessage[] = [
    { role: "system", content: REPORT_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `【逐题摘要】\n${digest}\n\n【统计】综合 ${report.avgScore} 分；真实性核验 ${report.authenticity.score} 分（${report.authenticity.samples} 题）；技术深度 ${report.depth.score} 分（${report.depth.samples} 题）。\n\n请按 JSON Schema 输出总结报告。`,
    },
  ];
  assertWithinContext(messages, "面试报告");

  // 用流式版：报告的思考过程也能实时推给前端
  const text = await chatStream(
    messages,
    { jsonSchema: REPORT_SCHEMA, temperature: 0.4, maxTokens: 2048 },
    onReasoning
  );
  const parsed = text ? parseJSON<any>(text) : null;
  if (!parsed || typeof parsed.overall !== "string") return fallback;

  const section = (title: string, items: unknown) =>
    Array.isArray(items) && items.filter((x) => typeof x === "string" && x.trim()).length
      ? `### ${title}\n${items.map((x: string) => `- ${x}`).join("\n")}`
      : "";
  return [
    head,
    `### 总评\n${parsed.overall}`,
    section("做得好的", parsed.strengths),
    section("短板", parsed.weaknesses),
    section("接下来怎么做", parsed.actions),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

export async function aiInterviewModule(app: FastifyInstance) {
  const prisma: PrismaClient = app.prisma;

  async function requireResume(reply: any, resumeId: string, userId: string) {
    const resume = await prisma.resume.findFirst({ where: { id: resumeId, userId } });
    if (!resume) {
      reply.code(404).send({ error: "简历不存在" });
      return null;
    }
    return resume;
  }

  /** 取会话全部原始行（按 createdAt asc 直读，这是 C 读取约定的排序，见 core/history.ts） */
  async function readRawRows(sessionId: string): Promise<RawRow[]> {
    return (await prisma.aiChatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        sessionId: true,
        role: true,
        content: true,
        edits: true,
        appliedIndexes: true,
        reasoning: true,
        meta: true,
        createdAt: true,
      },
    })) as RawRow[];
  }

  const EMPTY_HISTORY = (): AssembledHistory => ({ chain: [], digest: [], covered: [], plan: null });

  // -------------------------------------------------------------------------
  // 1. 面试会话列表（只列 mode=interview）
  // -------------------------------------------------------------------------
  app.get("/ai/interview/sessions", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { resumeId } = request.query as { resumeId?: string };
    if (!resumeId) return reply.code(400).send({ error: "resumeId 必填" });
    const resume = await requireResume(reply, resumeId, request.userId);
    if (!resume) return reply;

    const rows = await prisma.aiChatSession.findMany({
      where: { resumeId, userId: request.userId, mode: "interview" },
      orderBy: { lastMessageAt: "desc" },
      include: {
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { content: true } },
      },
    });
    return {
      sessions: rows.map((s: any) => ({
        id: s.id,
        resumeId: s.resumeId,
        title: s.title,
        // 下面三个字段只为与 ChatSessionMeta 结构兼容，好让前端复用 ChatSessionPicker
        focus: [] as string[],
        jd: null as string | null,
        targetRole: s.targetRole ?? null,
        messageCount: s._count?.messages ?? 0,
        lastMessageAt:
          s.lastMessageAt instanceof Date ? s.lastMessageAt.toISOString() : String(s.lastMessageAt),
        ...(s.messages?.[0]?.content ? { preview: String(s.messages[0].content).slice(0, 60) } : {}),
      })),
    };
  });

  // -------------------------------------------------------------------------
  // 2. 新建面试会话（SSE：流式产出面试计划 + 第一题，合成一条消息）
  // -------------------------------------------------------------------------
  app.post("/ai/interview/sessions", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const body = (request.body ?? {}) as {
      resumeId?: string;
      title?: string;
      targetRole?: string;
      /** 用户指定的题数；缺省用面试官（模型）给出的建议 */
      questionCount?: number;
    };
    if (!body.resumeId) return reply.code(400).send({ error: "resumeId 必填" });
    const resume = await requireResume(reply, body.resumeId, request.userId);
    if (!resume) return reply;
    if (!isLLMAvailable()) return reply.code(400).send({ error: "未配置 AI 模型，无法开始面试" });

    const content = resume.content as unknown as ResumeContent;
    const targetRole =
      cleanText(body.targetRole, 60) || cleanText(content?.basic?.title, 60) || null;

    // 注意：session 在 LLM 成功之后才创建（见下方 try 块）。
    // 反过来做的话，模型不可用/返回异常时会留下一条「有会话、但没有开题消息」的残缺记录，
    // 用户在这样的会话里作答时 currentTurnState 找不到任何在追问的题，追问层数会一直卡在第 1 层。

    ilog("建会话·生成计划 start", {
      resumeId: body.resumeId,
      targetRole: targetRole ?? "—",
      questionCount: body.questionCount ?? "auto",
    });
    const tCreate = timer();

    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache");
    raw.setHeader("Connection", "keep-alive");
    const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let reasoningTxt = "";
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: INTERVIEW_SYSTEM_PROMPT },
        {
          role: "user",
          content: buildInterviewUserContent({
            content,
            target: null,
            history: EMPTY_HISTORY(),
            withChain: false,
            targetRole,
            instruction:
              "这是面试的第一轮。请先给出面试计划（打算问哪几条简历条目、每个维度怎么切入、共几题），然后直接提出第一道题。isPlan 设为 true，planTotal 填计划总题数，probeDepth 填 0，question 填第一题。\n本题维度已指定为 **真实性核验**（dimension 填 \"authenticity\"），后续题目会由系统交替到技术深度。",
          }),
        },
      ];
      assertWithinContext(messages, "面试计划");

      const text = await chatStream(
        messages,
        { jsonSchema: INTERVIEW_SCHEMA, temperature: 0.6, maxTokens: 8192 },
        (d) => {
          reasoningTxt += d;
          send("reasoning", { delta: d });
        },
        (d) => send("content", { delta: d })
      );

      // 到这里才落库：任何一步失败都不会留下残缺会话
      if (!text) {
        send("error", { message: "AI 未返回内容，请重试或检查模型配置" });
        raw.end();
        return reply;
      }
      const parsed = parseJSON<any>(text);
      if (!parsed) {
        send("error", { message: "AI 返回格式异常，请重试" });
        raw.end();
        return reply;
      }

      const session = await prisma.aiChatSession.create({
        data: {
          resumeId: body.resumeId,
          userId: request.userId,
          title: cleanText(body.title, 60) ?? `模拟面试${targetRole ? ` · ${targetRole}` : ""}`,
          mode: "interview",
          targetRole,
          lastMessageAt: new Date(),
        },
      });

      const target = normalizeTarget(parsed.target);
      const meta: InterviewTurnMeta = {
        // 强制维度：首题固定为真实性核验（这是本功能的招牌），后续由系统交替
        dimension: "authenticity",
        probeDepth: 0,
        questionId: `q${Date.now().toString(36)}`,
        isPlan: true,
        isClosing: false,
        // 题数：用户指定优先，否则用面试官的建议（缺省 5）
        questionCount:
          typeof body.questionCount === "number" && body.questionCount > 0
            ? Math.min(Math.floor(body.questionCount), MAX_QUESTIONS)
            : clampScore(parsed.planTotal) || 5,
        covered: target ? [target] : [],
        ...(target ? { target, targetLabel: buildFieldLabel(target) } : {}),
      };
      ilog("建会话·计划完成", {
        sessionId: session.id,
        计划题数: meta.questionCount,
        首题维度: meta.dimension,
        首题目标: meta.targetLabel ?? meta.target ?? "—",
        耗时ms: tCreate(),
      });

      const assistant = await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: [
            cleanText(parsed.reply, 4000),
            `**第 1 题**（${DIMENSION_LABEL[meta.dimension]}${meta.targetLabel ? ` · ${meta.targetLabel}` : ""}）：${cleanText(parsed.question, 500) ?? ""}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          edits: [] as unknown as object,
          appliedIndexes: [] as unknown as object,
          meta: meta as unknown as object,
          reasoning: reasoningTxt || null,
        },
      });
      await recordCall(
        prisma,
        request.userId,
        { reasoning: reasoningTxt, output: text },
        { kind: "interview", resumeId: session.resumeId }
      );

        send("result", {
          sessionId: session.id,
          targetRole,
          message: toMessageRecord(assistant),
        });
      send("done", { ok: true });
    } catch (err) {
      console.error("[AI-INTERVIEW] 生成面试计划失败:", err);
      send("error", { message: "生成面试计划失败，请重试" });
    }
    raw.end();
    return reply;
  });

  // -------------------------------------------------------------------------
  // 3. 会话详情（全部消息，含 meta）
  // -------------------------------------------------------------------------
  app.get("/ai/interview/sessions/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId || session.mode !== "interview") {
      return reply.code(404).send({ error: "面试会话不存在" });
    }
    const rows = await readRawRows(id);
    return {
      session: { id: session.id, title: session.title, targetRole: session.targetRole ?? null },
      messages: rows.map((r) => toMessageRecord(r)),
    };
  });

  // -------------------------------------------------------------------------
  // 4. 重命名面试会话
  // -------------------------------------------------------------------------
  app.patch("/ai/interview/sessions/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: string };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) return reply.code(404).send({ error: "面试不存在" });
    const title = cleanText(body.title, 60);
    if (!title) return reply.code(400).send({ error: "标题不能为空" });
    const updated = await prisma.aiChatSession.update({ where: { id }, data: { title } });
    return { session: { id: updated.id, title: updated.title } };
  });

  // -------------------------------------------------------------------------
  // 5. 删除面试会话
  // -------------------------------------------------------------------------
  app.delete("/ai/interview/sessions/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) return reply.code(404).send({ error: "面试不存在" });
    await prisma.aiChatSession.delete({ where: { id } });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // 5. 面试报告（分数本地聚合，文字总结读缓存的 report 消息）
  // -------------------------------------------------------------------------
  app.get("/ai/interview/sessions/:id/report", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId || session.mode !== "interview") {
      return reply.code(404).send({ error: "面试会话不存在" });
    }
    const rows = await readRawRows(id);
    const reportRow = rows.find((r) => parseMeta(r.meta)?.isReport);
    const plan = rows.map((r) => parseMeta(r.meta)).find((m) => m?.isPlan);
    return {
      report: aggregateReport(id, rows, plan?.questionCount ?? 0, !!reportRow),
      text: reportRow?.content ?? null,
    };
  });

  // -------------------------------------------------------------------------
  // 6. 发消息（SSE）
  //    action=answer 判定当前回答 → 追问 or 收尾（收尾会再开新题，两次调用）
  //    action=next   跳过当前题，直接开新题
  //    action=finish 结束并出报告
  // -------------------------------------------------------------------------
  app.post("/ai/interview/sessions/:id/messages", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: string; action?: string };
    const action = (body.action ?? "answer") as InterviewAction;
    if (!["answer", "next", "finish"].includes(action)) {
      return reply.code(400).send({ error: "action 不合法" });
    }
    const userText = cleanText(body.content, 8000) ?? "";
    if (action === "answer" && !userText) return reply.code(400).send({ error: "回答不能为空" });

    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId || session.mode !== "interview") {
      return reply.code(404).send({ error: "面试会话不存在" });
    }
    const resume = await prisma.resume.findFirst({ where: { id: session.resumeId, userId: request.userId } });
    if (!resume) return reply.code(404).send({ error: "简历不存在" });
    if (!isLLMAvailable()) return reply.code(400).send({ error: "未配置 AI 模型，无法继续面试" });

    const content = resume.content as unknown as ResumeContent;

    // 直读原始行（不截断 meta），定位当前题与深度
    const rows = await readRawRows(id);
    const turn = currentTurnState(rows);
    ilog(`回合 ${action}`, { sessionId: id, 当前题: turn.questionId ?? "（无）", 当前深度: turn.depth });
    const targetRole = session.targetRole ?? null;
    const push = async (meta: InterviewTurnMeta, body: string, extra?: Record<string, unknown>) =>
      prisma.aiChatMessage.create({
        data: {
          sessionId: id,
          role: "assistant",
          content: body,
          edits: [] as unknown as object,
          appliedIndexes: [] as unknown as object,
          meta: meta as unknown as object,
          ...(extra ?? {}),
        },
      });

    // 用户回答先落库：LLM 失败也不丢用户的作答。
    // 记下完整行，SSE result 里要回传——前端是乐观上屏的，若不回传会把自己那条删掉且补不回来，
    // 导致「已作答」被误判成「已跳过」。
    let userRecord: RawRow | null = null;
    if (action === "answer") {
      userRecord = (await prisma.aiChatMessage.create({
        data: {
          sessionId: id,
          role: "user",
          content: userText,
          meta: { questionId: turn.questionId, answered: userText.slice(0, 200) } as unknown as object,
        },
      })) as unknown as RawRow;
    }

    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache");
    raw.setHeader("Connection", "keep-alive");
    const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let reasoningTxt = "";
    const onReasoning = (d: string) => {
      reasoningTxt += d;
      send("reasoning", { delta: d });
    };

    // 开新题的共用上下文（history 由各分支覆盖，带上真实的覆盖地图）
    const nextCtx = {
      content,
      rows,
      history: EMPTY_HISTORY(),
      targetRole,
      resumeId: session.resumeId,
      userId: request.userId,
      onReasoning,
      send,
      push,
      prisma,
    };

    try {
      // ================= 分支 A：结束面试，出报告 =================
      if (action === "finish") {
        const history = buildInterviewHistory(rows, null); // 报告不需要保留链，只要摘要
        const report = aggregateReport(
          id,
          rows,
          history.plan?.questionCount ?? 0,
          true
        );
        ilog("生成报告", { 计划题数: report.questionCount, 综合分: report.avgScore });
        const reportText = await buildReportText(history, report, onReasoning);
        const meta: InterviewTurnMeta = {
          dimension: "authenticity",
          probeDepth: 0,
          questionId: "report",
          isReport: true,
          questionCount: report.questionCount,
          score: report.avgScore,
          covered: report.questions.map((q) => q.target).filter((x): x is string => !!x),
        };
        const assistant = await push(meta, reportText);
        await prisma.aiChatSession.update({ where: { id }, data: { lastMessageAt: new Date() } });
        send("result", { message: toMessageRecord(assistant), report });
        send("done", { ok: true });
        raw.end();
        return reply;
      }

      // ================= 分支 B：判定当前回答 =================
      if (action === "answer") {
        const history = buildInterviewHistory(rows, turn.questionId);
        const depth = safeDepth(turn.depth);
        // 追问不换考察对象；换题时该问的是新条目
        const followTarget = lastTargetOf(rows);
        const canFollow = depth < MAX_PROBE_DEPTH;
        // 维度沿用本题开题时定的那个（服务端强制交替过）。必须在构造 instruction 之前算出来，
        // 它只读 rows、不依赖 LLM 响应。
        const dimension: InterviewDimension = questionDimensionOf(rows) ?? "authenticity";
        ilog("判定轮 start", { 深度: depth, 可追问: canFollow, 维度: dimension, 目标: followTarget ?? "—" });
        const tJudge = timer();

        const messages: ChatMessage[] = [
          { role: "system", content: INTERVIEW_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildInterviewUserContent({
              content,
              target: followTarget,
              history,
              withChain: true,
              targetRole,
              userText,
              instruction: JUDGE_INSTRUCTION.replace("{depth}", String(depth))
                .replace("{next}", String(Math.min(depth + 1, MAX_PROBE_DEPTH)))
                .replace("{dimension}", `${DIMENSION_LABEL[dimension]}（${dimension}）`),
            }),
          },
        ];
        assertWithinContext(messages, `判定轮(depth=${depth})`);

        const text = await chatStream(
          messages,
          { jsonSchema: INTERVIEW_SCHEMA, temperature: 0.6, maxTokens: 8192 },
          onReasoning,
          (d) => send("content", { delta: d })
        );
        if (!text) {
          send("error", { message: "AI 未返回内容，请重试" });
          raw.end();
          return reply;
        }
        const parsed = parseJSON<any>(text);
        if (!parsed) {
          send("error", { message: "AI 返回格式异常，请重试" });
          raw.end();
          return reply;
        }

        const basis = cleanVerdictBasis(parsed);
        const score = typeof parsed.score === "number" ? clampScore(parsed.score) : undefined;
        // 追问判定：模型说了算，但到顶/它主动收尾就不追——审问不散是硬约束
        const willFollow = canFollow && parsed.shouldFollow === true && !!cleanText(parsed.question, 500);
        ilog("判定结果", {
          继续追问: willFollow,
          分数: score ?? "未给（沿用上一轮）",
          结论: dimension === "authenticity" ? clampVerdict(parsed.verdict) : "（depth 无结论）",
          依据条数: basis.quotes.length,
          缺口: cleanText(parsed.gap, 200) ?? "—",
          耗时ms: tJudge(),
        });

        const meta: InterviewTurnMeta = {
          dimension,
          // 写入前再过一次 safeDepth：保证 meta.probeDepth 永远是 0|1|2|3 的合法整数。
          // 一旦 NaN 落库（JSON 会存成 null），后续每轮都会从 0 重新开始，追问永远卡在第 1 层。
          probeDepth: safeDepth(willFollow ? depth + 1 : depth),
          questionId: turn.questionId ?? `q${Date.now().toString(36)}`,
          isClosing: !willFollow,
          covered: history.covered,
          ...(followTarget ? { target: followTarget, targetLabel: buildFieldLabel(followTarget) } : {}),
          ...(dimension === "authenticity" ? { verdict: clampVerdict(parsed.verdict) } : {}),
          ...(score !== undefined ? { score } : {}),
          ...(basis.quotes.length ? { quotes: basis.quotes } : {}),
          ...(basis.reasons.length ? { reasons: basis.reasons } : {}),
          ...(cleanText(parsed.gap, 200) ? { gap: cleanText(parsed.gap, 200) } : {}),
          ...(cleanText(parsed.answered, 200) ? { answered: cleanText(parsed.answered, 200) } : {}),
        };

        // 追问中挖出的简历外细节 → edits 卡片，用户点「应用」才落库（绝不自动回写)
        const { edits } = validateEdits(parsed.edits, content, userText, userText);

        const questionText = cleanText(parsed.question, 500);
        const judgeBody = [
          cleanText(parsed.reply, 2000),
          questionText ? `**${willFollow ? `追问 · 第 ${meta.probeDepth} 层` : "本题结束"}**（${DIMENSION_LABEL[dimension]}）：${questionText}` : "",
          basis.quotes.length
            ? `判定依据：\n${basis.quotes.map((q, i) => `- 「${q}」—— ${basis.reasons[i]}`).join("\n")}`
            : "",
          meta.gap ? `还没答上来：${meta.gap}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const judgeMsg = await push(meta, judgeBody || "（AI 未返回文本）", {
          edits: edits as unknown as object,
          reasoning: reasoningTxt || null,
        });

        const payload: Record<string, unknown> = {
          message: toMessageRecord(judgeMsg),
          edits,
          covered: history.covered,
        };
        // 把用户这条一并回传，让前端用真实 id/createdAt 替换它的乐观副本
        if (userRecord) payload.userMessage = toMessageRecord(userRecord);

        // 该收尾 → 紧接着开一道新题（见文件头「状态机」说明）
        // 但如果已达计划题数，就不再开新题：planTotal 原本只是「计划」，从不参与终止判断，
        // 结果是模型会无限开新题、必须靠用户手动点结束。到达计划数后交给用户决定是否继续深挖。
        if (!willFollow) {
          const planTotal = history.plan?.questionCount ?? 0;
          const askedCount = groupByQuestion(rows).length; // rows 含当前题（开题消息在上一轮已落库）
          const planReached = planTotal > 0 && askedCount >= planTotal;

          if (planReached) {
            ilog("计划达成·不再自动开新题", { 已开题数: askedCount, 计划题数: planTotal });
            payload.planReached = { planTotal, askedCount };
          } else {
            ilog("本题收尾·继续开新题", { 已开题数: askedCount, 计划题数: planTotal });
            // 当前题此刻还在 chain 里（未进 digest），换题前要把它压成摘要交给新题上下文
            const ended = turn.questionId
              ? groupByQuestion(rows).find((g) => g.questionId === turn.questionId)
              : undefined;
            const extraDigest = ended ? [summarizeGroup(ended)] : [];
            const next = await openNewQuestion({ ...nextCtx, history, extraDigest });
            if (next) {
              payload.message2 = toMessageRecord(next.row);
              payload.covered = next.covered;
              if (next.edits.length) payload.edits = [...(payload.edits as ResumeEdit[]), ...next.edits];
            }
          }
        }

        await prisma.aiChatSession.update({ where: { id }, data: { lastMessageAt: new Date() } });
        await recordCall(
          prisma,
          request.userId,
          { reasoning: reasoningTxt, output: text },
          { kind: "interview", resumeId: session.resumeId }
        );
        send("result", payload);
        send("done", { ok: true });
        raw.end();
        return reply;
      }

      // ================= 分支 C：action=next，跳过当前题直接开新题 =================
      {
        const history = buildInterviewHistory(rows, null); // 旧题不再需要原文
        const next = await openNewQuestion({ ...nextCtx, history });
        if (!next) {
          send("error", { message: "AI 未返回内容，请重试" });
          raw.end();
          return reply;
        }
        await prisma.aiChatSession.update({ where: { id }, data: { lastMessageAt: new Date() } });
        send("result", { message: toMessageRecord(next.row), covered: next.covered });
        send("done", { ok: true });
        raw.end();
        return reply;
      }
    } catch (err) {
      console.error("[AI-INTERVIEW] 面试回合失败:", err);
      send("error", { message: "面试回合失败，请重试" });
    }
    raw.end();
    return reply;
  });

  /** 开一道新题：独立的一次 LLM 调用（与判定轮分开，保证一条消息只归属一道题） */
  async function openNewQuestion(ctx: {
    content: ResumeContent;
    rows: RawRow[];
    history: AssembledHistory;
    /** 刚结束的那一题（判定轮收尾时它还在 chain 里，尚未进 digest），换题时要一并告诉模型 */
    extraDigest?: string[];
    targetRole: string | null;
    resumeId: string;
    userId: string;
    onReasoning: (d: string) => void;
    send: (event: string, data: unknown) => void;
    push: (meta: InterviewTurnMeta, body: string, extra?: Record<string, unknown>) => Promise<any>;
    prisma: PrismaClient;
  }) {
    // 维度由服务端强制交替：统计已出题各维度的数量，少的那个就是本题要考的。
    // 不信任模型自选的 dimension —— 实测它会整场重复同一个维度。
    const askedDims = groupByQuestion(ctx.rows)
      .map((g) => parseMeta(g.rows.find((r) => r.role === "assistant")?.meta)?.dimension)
      .filter((d): d is InterviewDimension => d === "depth" || d === "authenticity");
    const dimension: InterviewDimension = askedDims.length ? nextDimension(askedDims) : "authenticity";
    const tQ = timer();
    idbg("维度交替", { 已考维度: askedDims, 本题: dimension });

    const messages: ChatMessage[] = [
      { role: "system", content: INTERVIEW_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildInterviewUserContent({
          content: ctx.content,
          target: null,
          // 摘要统一在这里再封顶一次：调用方传来的 digest 可能还没把「刚结束的那题」算进去
          history: {
            ...ctx.history,
            digest: trimDigest([...(ctx.extraDigest ?? []), ...ctx.history.digest], historyBudgets().digest),
          },
          withChain: false,
          targetRole: ctx.targetRole,
          instruction: `${NEXT_QUESTION_INSTRUCTION}\n本题维度已指定为 **${DIMENSION_LABEL[dimension]}**（dimension 字段填 "${dimension}"），必须围绕这个维度提问。`,
        }),
      },
    ];
    assertWithinContext(messages, "开新题");

    const text = await chatStream(
      messages,
      { jsonSchema: INTERVIEW_SCHEMA, temperature: 0.7, maxTokens: 4096 },
      ctx.onReasoning,
      (d) => ctx.send("content", { delta: d })
    );
    if (!text) return null;
    const parsed = parseJSON<any>(text);
    if (!parsed) return null;

    const question = cleanText(parsed.question, 500);
    if (!question) return null;

    const rawTarget = normalizeTarget(parsed.target);
    // 连续两题撞同一条目时强制换一个（隔题复用同一条目是允许的）
    const target = pickNextTarget(ctx.content, rawTarget, lastTargetOf(ctx.rows), ctx.history.covered);
    const covered = Array.from(
      new Set([
        ...ctx.history.covered,
        ...(Array.isArray(parsed.covered)
          ? parsed.covered.filter((x: unknown): x is string => typeof x === "string")
          : []),
        ...(target ? [target] : []),
      ])
    );
    const meta: InterviewTurnMeta = {
      // 强制维度（见上方 askedDims 计算），不采用模型返回的 dimension
      dimension,
      probeDepth: 0,
      questionId: `q${Date.now().toString(36)}${covered.length}`,
      isClosing: false,
      covered,
      ...(target ? { target, targetLabel: buildFieldLabel(target) } : {}),
    };
    ilog("开新题", { 维度: dimension, 目标: target ? buildFieldLabel(target) : "—", 覆盖数: covered.length, 耗时ms: tQ() });

    const { edits } = validateEdits(parsed.edits, ctx.content, "", "");
    const body = [
      cleanText(parsed.reply, 1000),
      `**换题 · ${DIMENSION_LABEL[meta.dimension]}${meta.targetLabel ? ` · ${meta.targetLabel}` : ""}**：${question}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const row = await ctx.push(meta, body, { edits: edits as unknown as object });
    await recordCall(
      ctx.prisma,
      ctx.userId,
      { reasoning: null, output: text },
      { kind: "interview", resumeId: ctx.resumeId }
    );
    return { row, meta, covered, edits };
  }
}
