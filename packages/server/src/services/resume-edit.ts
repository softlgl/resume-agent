// AI 修改建议的服务端权威校验层
// 职责：把 AI 产出的原始 edit 归一化成前端可安全应用的 ResumeEdit，
//       挡住路径注入、下标越界、容器覆写、AI 编造事实字段等风险。
// 前端 applyEdit 仍有二次防御，但这里是唯一的事实来源。

import type { EditSection, ResumeContent, ResumeEdit } from "@resume-agent/shared";

// ---------------------------------------------------------------------------
// 常量表
// ---------------------------------------------------------------------------

// 每个 section 允许被 set/append 的字段（仅 string 类型；works.current 是 boolean，排除）
export const SETTABLE_FIELDS: Record<EditSection, string[]> = {
  basic: [
    "name",
    "title",
    "phone",
    "email",
    "location",
    "website",
    "summary",
    "avatar",
    "birthday",
    "gender",
    "currentStatus",
    "expectedSalary",
    "workYears",
  ],
  works: ["company", "role", "start", "end", "description"],
  educations: ["school", "major", "degree", "start", "end", "description"],
  projects: ["name", "company", "role", "start", "end", "link", "description"],
  skills: ["category", "items"],
};

// append 必填项（口径与 ai.ts ruleChecks 对齐）
export const APPEND_REQUIRED: Record<Exclude<EditSection, "basic">, string[]> = {
  works: ["company", "role", "start"],
  educations: ["school", "start"],
  projects: ["name"],
  skills: ["category", "items"],
};

// append 时的事实字段：AI 不得凭空产生，只有用户明确说过的才保留，否则置空由用户在卡片里补
export const APPEND_BLANK_FACTS = ["start", "end", "link"];

/**
 * 某个值是否确实出现在用户说过的话里（防 AI 编造）。
 * 时间类值放宽：用户写「2023年3月」而 AI 写「2023-03」也要认。
 */
export function appearsInConversation(text: string, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (text.includes(v)) return true;

  const m = /(\d{2,4})\D{0,3}(\d{1,2})?/.exec(v);
  if (!m) return false;
  const year = m[1];
  if (!text.includes(year)) return false;
  if (!m[2]) return true;

  const month = String(Number(m[2]));
  if (/^0+$/.test(month)) return text.includes(year);
  // 年份后 4 个字符内出现该月份（允许「年/月/-/.」等分隔，且不误吃 10/11/12 月）
  return new RegExp(`${year}\\D{0,4}0?${month}(?=\\D|$)`).test(text);
}

// append 中需在对话原文里出现过才可信的字段 → 未出现时写入 risks
const APPEND_VERIFY_IN_TEXT: Partial<Record<EditSection, string[]>> = {
  works: ["company"],
  educations: ["school"],
  projects: ["name"],
};

const SECTION_LABELS: Record<string, string> = {
  basic: "基本信息",
  works: "工作经历",
  educations: "教育经历",
  projects: "项目经历",
  skills: "技能",
};

/** section 的中文名（供拼装追问文案） */
export function sectionLabel(section: string): string {
  return SECTION_LABELS[section] || section;
}

const FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  title: "求职意向",
  phone: "手机号",
  email: "邮箱",
  location: "所在地",
  website: "个人主页",
  summary: "个人简介",
  avatar: "头像",
  birthday: "出生年月",
  gender: "性别",
  currentStatus: "当前状态",
  expectedSalary: "期望薪资",
  workYears: "工作年限",
  company: "公司名称",
  role: "职位",
  start: "开始时间",
  end: "结束时间",
  current: "是否至今",
  description: "描述",
  school: "学校",
  major: "专业",
  degree: "学历",
  link: "项目链接",
  category: "分类",
  items: "技能",
};

// 同名字段在不同 section 下的中文名不同（projects.name 是项目名称，不是姓名）
const SECTION_FIELD_OVERRIDES: Partial<Record<EditSection, Record<string, string>>> = {
  projects: { name: "项目名称" },
};

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

const SECTION_NAMES = Object.keys(SETTABLE_FIELDS).join("|");
const PATH_RE = new RegExp(`^(${SECTION_NAMES})(?:\\[(\\d+)\\])?(?:\\.([A-Za-z0-9_]+))?$`);

export interface ParsedPath {
  section: EditSection;
  index: number | null;
  key: string | null;
}

/** 解析 "works[0].description" / "basic.summary"；不合法返回 null */
export function parseFieldPath(field: string): ParsedPath | null {
  if (typeof field !== "string") return null;
  const m = PATH_RE.exec(field.trim());
  if (!m) return null;
  return {
    section: m[1] as EditSection,
    index: m[2] === undefined ? null : Number(m[2]),
    key: m[3] ?? null,
  };
}

/** 把 JSON 路径转成中文可读定位文本（与前端 fieldToLabel 口径一致） */
export function buildFieldLabel(field: string): string {
  if (!field) return "";
  const parsed = parseFieldPath(field);
  const top = parsed?.section ?? field.split(/[.\[\]]+/)[0];
  const section = SECTION_LABELS[top] || top;
  const m = /\[(\d+)\]/.exec(field);
  const idxPart = m ? ` · 第${Number(m[1]) + 1}条` : "";
  const tokens = field.split(/[.\[\]]+/).filter(Boolean);
  const lastKey = tokens[tokens.length - 1];
  const override = parsed ? SECTION_FIELD_OVERRIDES[parsed.section]?.[lastKey] : undefined;
  const fieldName = override || FIELD_LABELS[lastKey] || lastKey;
  return `${section}${idxPart} · ${fieldName}`;
}

/** 读取路径指向的当前值（只支持 basic.key 与 section[idx].key 两种形态） */
export function readFieldValue(content: ResumeContent, field: string): string | null {
  const parsed = parseFieldPath(field);
  if (!parsed || !parsed.key) return null;
  if (parsed.section === "basic") {
    const v = (content.basic as unknown as Record<string, unknown>)[parsed.key];
    return typeof v === "string" ? v : null;
  }
  const list = content[parsed.section] as unknown as Record<string, unknown>[];
  if (!Array.isArray(list) || parsed.index === null) return null;
  const row = list[parsed.index];
  if (!row) return null;
  const v = row[parsed.key];
  return typeof v === "string" ? v : null;
}

/** 与前端 SectionForm.uid() 同算法，保证条目 id 风格一致 */
export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// 事实字段防线
// ---------------------------------------------------------------------------

// AI 不可能知道、也不允许编造的真实值（时间/链接/联系方式/薪资/出生年月等）
const NO_REWRITE_PATTERNS = [
  /\.(start|end|link|url|github|gitee|phone|mobile|tel|email|mail|qq|wechat|wx|address|location|salary|expect|expectedSalary|birthday|birth|age|gender|avatar|photo|image|portfolio|blog|website|homepage|doubao|zhihu|bilibili|juejin|csdn|leetcode|hotjob|jobPosition|jobLevel)$/i,
  /^basic\.(name|realName)$/i, // 姓名同样不允许 AI 改写
];

/** 该字段是否禁止 AI 改写（命中则整条 edit 丢弃） */
export function isNoRewriteField(field: string): boolean {
  return NO_REWRITE_PATTERNS.some((re) => re.test(field));
}

// 姓名任何情况下都不允许 AI 写入（客户端本地回填保护）
const NAME_RE = /^basic\.(name|realName)$/i;

// 编辑器用月份选择器（type="month"）的字段：只接受 YYYY-MM
const MONTH_FIELD_RE = /^(?:basic\.birthday|(?:works|educations|projects)\[\d+\]\.(?:start|end))$/i;

// ---------------------------------------------------------------------------
// 编造事实检测（只做提示，不阻断）
// ---------------------------------------------------------------------------

const FACT_NUM_RE = /\d+(?:\.\d+)?%?/g;
const FACT_LATIN_RE = /[A-Za-z][A-Za-z0-9+#.\-]{2,}/g;

/**
 * 找出 after 中出现、但 before 中没有的数字/百分比与拉丁术语。
 * 局限：中文新技术名词（如「微服务」「灰度发布」）抓不到，只能靠 prompt 约束。
 */
export function detectNewFacts(before: string, after: string): string[] {
  const collect = (text: string, re: RegExp) => {
    const out = new Set<string>();
    for (const m of text.match(re) ?? []) out.add(m);
    return out;
  };
  const beforeLower = before.toLowerCase();
  const found: string[] = [];

  const push = (v: string, seen: Set<string>) => {
    if (seen.has(v)) return;
    seen.add(v);
    if (v.length < 2) return;
    if (beforeLower.includes(v.toLowerCase())) return;
    found.push(v);
  };

  const numSeen = collect(before, FACT_NUM_RE);
  for (const v of collect(after, FACT_NUM_RE)) push(v, numSeen);

  const latinSeen = collect(before.toLowerCase(), FACT_LATIN_RE);
  for (const v of collect(after, FACT_LATIN_RE)) push(v, latinSeen);

  if (found.length === 0) return [];
  return [`可能引入了原文没有的信息：${found.slice(0, 6).join("、")}`];
}

// ---------------------------------------------------------------------------
// 建议式文字过滤（沿用 ai.ts stripSuggestionRewrites 的语义）
// ---------------------------------------------------------------------------

const SUGGESTION_PATTERNS = [/^建议/, /^可以/, /^推荐/, /^应该/, /^最好/, /需补充/, /需添加/, /请填写/, /请补充/];

function looksLikeSuggestion(text: string): boolean {
  return SUGGESTION_PATTERNS.some((re) => re.test(text.trim()));
}

// ---------------------------------------------------------------------------
// 时间兜底抽取：AI 漏给 start/end 时，从用户原话里照抄一段区间
// 只做「抄录」，不做推断（抽不到就留空，卡片仍要求用户手填）
// ---------------------------------------------------------------------------

// 「2023年3月」「2023年」「2023-03」「2023.3」「2023/03」
// 刻意不认光秃秃的 2023，避免误抓手机号等长数字里的片段
const DATE_TOKEN_SRC = "((?:19|20)\\d{2})\\s*(?:年\\s*(\\d{1,2})?\\s*月?|([-/.])\\s*(\\d{1,2}))";
const NOW_RE = /至今|现在|目前|在职/;
// 叙述经历时紧挨日期的提示词（「2021年7月入职」「2023年3月离职」「从2021年开始」），
// 用于多日期场景判断哪个日期属于本条经历
const TIMELINE_KEYWORD_RE = /从|自|入职|加入|任职|开始|实习|工作|在职|毕业|就读|在读|项目|至今|离职|离开|辞职|止/;

export interface TimelineGuess {
  start: string;
  end: string;
}

// 分句边界：时间只有落在条目名所在的同一分句里，才算这条经历的时间
const CLAUSE_BREAK_RE = /[，。；、,;.!?！？\n\r\t ]/;
function clauseRange(text: string, at: number): [number, number] {
  let lo = at;
  while (lo > 0 && !CLAUSE_BREAK_RE.test(text[lo - 1])) lo--;
  let hi = at;
  while (hi < text.length && !CLAUSE_BREAK_RE.test(text[hi])) hi++;
  return [lo, hi];
}

/**
 * 在文本里定位条目名；AI 可能把名字写长（「字节跳动有限公司」vs 用户说的「字节跳动」），
 * 精确匹配不到时退化为「最长公共片段」，仍不上就返回 -1（说明用户压根没提过这个条目）。
 */
function locateName(text: string, name: string): number {
  if (!name) return -1;
  const at = text.indexOf(name);
  if (at >= 0) return at;
  for (let len = name.length - 1; len >= 2; len--) {
    for (let i = 0; i + len <= name.length; i++) {
      const hit = text.indexOf(name.slice(i, i + len));
      if (hit >= 0) return hit;
    }
  }
  return -1;
}

/**
 * 从用户原话里兜底抽取一段经历的时间区间。
 * 顺序：条目名所在分句 → 紧挨「入职/开始/离职」等词的日期 → 全文只有 1~2 个日期才敢用。
 * 第二个时间点必须紧邻第一个（≤60 字符）才算结束时间，避免把无关日期当结束。
 */
export function guessTimeline(text: string, anchor?: string, useKeyword = true): TimelineGuess | null {
  if (!text) return null;

  const hits: { raw: string; index: number }[] = [];
  const re = new RegExp(DATE_TOKEN_SRC, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) hits.push({ raw: m[0].trim(), index: m.index });
  if (hits.length === 0) return null;

  // ① 条目名（公司/学校/项目名）所在分句里的第一个日期
  let start: { raw: string; index: number } | null = null;
  const name = (anchor ?? "").trim();
  if (name) {
    const at = locateName(text, name);
    if (at >= 0) {
      const [lo, hi] = clauseRange(text, at);
      const inClause = hits.filter((h) => h.index >= lo && h.index < hi);
      if (inClause.length > 0) start = inClause[0];
      else {
        // 名字单独成句、或与时间分处两句（「字节跳动」「2021年7月入职」）→
        // 放宽到名字附近的日期，优先取名字之后的（「某某公司 2021年7月-2023年9月」）
        const near = hits.filter((h) => Math.abs(h.index - at) <= 60);
        const after = near.filter((h) => h.index > at);
        const pool = after.length > 0 ? after : near;
        if (pool.length > 0) start = pool[0];
      }
    }
  }
  // ② 紧挨「入职/加入/开始/离职」这类词的日期
  //    仅在条目名能在原话里对上时才用：名字都对不上，说明这条经历用户没提过，
  //    再按关键词抓第一个日期就是在给别的经历乱挂时间。
  if (!start && useKeyword) {
    start = hits.find((h) => {
      const around = text.slice(Math.max(0, h.index - 8), h.index + h.raw.length + 8);
      return TIMELINE_KEYWORD_RE.test(around);
    }) ?? null;
  }
  // ③ 全文只有 1~2 个日期才敢用（多了归属不确定，不猜）
  if (!start) {
    if (hits.length > 2) return null;
    start = hits[0];
  }

  // 结束时间：起始点之后紧邻（≤60 字符）的下一个日期
  const next = hits.find((h) => h.index > start.index && h.index - start.index <= 60);
  if (next) return { start: start.raw, end: next.raw };

  // 只有一个时间点：紧跟「至今」才当结束时间，否则留空
  const tail = text.slice(start.index + start.raw.length, start.index + start.raw.length + 8);
  return { start: start.raw, end: NOW_RE.test(tail) ? "至今" : "" };
}

// ---------------------------------------------------------------------------
// append 条目归一化
// ---------------------------------------------------------------------------

export interface NormalizedAppend {
  item: Record<string, string | boolean>;
  risks: string[];
  itemId: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 把各种写法的时间收敛成简历约定的 YYYY-MM。
 * 「2023年3月」「2023-3」「2023.03」→「2023-03」；只给年份（无月份）返回空串——不替用户编月份。
 */
export function toMonth(v: string): string {
  const m = /((?:19|20)\d{2})\D{0,3}(\d{1,2})?/.exec(v.trim());
  if (!m) return "";
  const mm = m[2] ? Number(m[2]) : 0;
  if (mm < 1 || mm > 12) return "";
  return `${m[1]}-${String(mm).padStart(2, "0")}`;
}

/**
 * 把 AI 给的 append 条目归一化：
 * - 只保留该 section 的合法字段
 * - 事实字段（start/end/link）只有用户明确说过的才保留，其余置空由用户补
 * - AI 漏给时间时，从用户原话里兜底抄一段
 * - 时间统一成 YYYY-MM（编辑器月份框只认这个格式，「至今」改用 current 布尔表示）
 * - 生成条目 id
 * - 对「需在对话原文中出现」的字段给出风险提示
 *
 * @param verifyText 用于事实核验的文本（只含用户自己说过的话）
 * @param dateText   用于抽取时间的文本（优先当前这条消息，抽不到再退回 verifyText）
 */
export function normalizeAppendItem(
  section: EditSection,
  raw: unknown,
  verifyText = "",
  dateText = verifyText
): NormalizedAppend | null {
  if (section === "basic") return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const allowed = SETTABLE_FIELDS[section];
  const src = raw as Record<string, unknown>;
  const item: Record<string, string | boolean> = {};

  for (const key of allowed) {
    item[key] = typeof src[key] === "string" ? (src[key] as string).trim() : "";
  }
  // 事实字段：用户说过就留下，没说过一律置空（AI 不得编造时间与链接）
  for (const key of APPEND_BLANK_FACTS) {
    if (!(key in item)) continue;
    const v = str(item[key]);
    if (!v || !appearsInConversation(verifyText, v)) item[key] = "";
  }

  // 时间收敛成 YYYY-MM；「至今」不是合法月份，改用 current 布尔（works 支持）
  // 只给到年份（如「2021」）收不动会被清空，交给下面的兜底重新从原话里抄
  for (const key of ["start", "end"]) {
    const v = str(item[key]);
    if (!v) continue;
    if (key === "end" && NOW_RE.test(v)) {
      if (section === "works") item.current = true;
      item.end = "";
      continue;
    }
    item[key] = toMonth(v);
  }

  // 收敛后仍没有开始时间 → 从用户原话里兜底抄一段（skills 无时间字段，跳过）
  if (section !== "skills" && !str(item.start)) {
    const anchor = str(item.company) || str(item.school) || str(item.name);
    // 条目名在用户原话里能对得上，才允许用「关键词邻近」这条启发式
    const useKeyword = !anchor || locateName(dateText, anchor) >= 0 || locateName(verifyText, anchor) >= 0;
    const guess =
      guessTimeline(dateText, anchor, useKeyword) ?? guessTimeline(verifyText, anchor, useKeyword);
    if (guess) {
      const start = toMonth(guess.start);
      if (start) item.start = start;
      if (!str(item.end)) {
        if (NOW_RE.test(guess.end)) {
          if (section === "works") item.current = true;
        } else {
          const end = toMonth(guess.end);
          if (end) item.end = end;
        }
      }
    }
  }

  const risks: string[] = [];
  for (const key of APPEND_VERIFY_IN_TEXT[section] ?? []) {
    const v = str(item[key]);
    if (v && !verifyText.includes(v)) {
      risks.push(`「${v}」未在对话中出现，请确认真实性`);
    }
  }

  return { item, risks, itemId: uid() };
}

/** 返回缺失的必填字段中文名（供卡片表单红字提示） */
export function checkAppendRequired(section: EditSection, item: Record<string, unknown>): string[] {
  if (section === "basic") return [];
  const required = APPEND_REQUIRED[section] ?? [];
  const overrides = SECTION_FIELD_OVERRIDES[section] ?? {};
  return required
    .filter((key) => !String(item[key] ?? "").trim())
    .map((key) => overrides[key] || FIELD_LABELS[key] || key);
}

// ---------------------------------------------------------------------------
// 主校验入口
// ---------------------------------------------------------------------------

export interface ValidateEditsResult {
  edits: ResumeEdit[];
  rejected: string[];
}

/**
 * 逐条校验 AI 返回的 edits。
 * 任何一条不过就丢弃该条并把原因放进 rejected（不整体失败，保证对话仍可用）。
 *
 * @param userText      用户当前这条消息（抽时间优先用它）
 * @param userConvoText 用户在本会话里说过的全部话（仅 user 角色 + 当前消息），事实核验只用它
 */
export function validateEdits(
  raw: unknown,
  content: ResumeContent,
  userText = "",
  userConvoText = userText
): ValidateEditsResult {
  const edits: ResumeEdit[] = [];
  const rejected: string[] = [];

  if (!Array.isArray(raw)) {
    return { edits, rejected: [] };
  }

  raw.forEach((entry, i) => {
    const idxLabel = `第 ${i + 1} 条建议`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      rejected.push(`${idxLabel}：格式不正确`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const op = e.op;
    const reason = typeof e.reason === "string" ? e.reason.trim() : "";
    const aiRisks = Array.isArray(e.risks)
      ? e.risks.filter((r): r is string => typeof r === "string" && !!r.trim())
      : [];

    if (op === "set") {
      const field = typeof e.field === "string" ? e.field.trim() : "";
      const parsed = parseFieldPath(field);
      if (!parsed) {
        rejected.push(`${idxLabel}：字段路径无效（${field || "空"}）`);
        return;
      }
      const { section, index, key } = parsed;
      if (!key) {
        // works / projects 这类容器字段不能整体覆写成文本
        rejected.push(`${idxLabel}：不允许整体改写「${SECTION_LABELS[section] || section}」`);
        return;
      }
      if (!SETTABLE_FIELDS[section].includes(key)) {
        rejected.push(`${idxLabel}：字段「${key}」不可写入`);
        return;
      }
      if (section === "basic") {
        if (index !== null) {
          rejected.push(`${idxLabel}：基本信息不支持下标`);
          return;
        }
      } else {
        if (index === null) {
          rejected.push(`${idxLabel}：缺少条目下标（${field}）`);
          return;
        }
        const list = content[section] as unknown as unknown[];
        if (!Array.isArray(list) || index >= list.length) {
          rejected.push(`${idxLabel}：条目不存在（${field}）`);
          return;
        }
      }
      let after = typeof e.after === "string" ? e.after.trim() : "";
      if (!after) {
        rejected.push(`${idxLabel}：改写内容为空`);
        return;
      }
      // 月份类字段（出生年月 / 起止时间）编辑器是 type="month"，只认 YYYY-MM；
      // 写入别的格式会在界面上变成空白，这里统一收敛，收不动的直接拒绝并说明原因。
      if (MONTH_FIELD_RE.test(field)) {
        const norm = toMonth(after);
        if (!norm) {
          rejected.push(`${idxLabel}：${buildFieldLabel(field)} 需要「YYYY-MM」格式的月份（若是至今，请在编辑器里勾选「至今」）`);
          return;
        }
        after = norm;
      }
      if (NAME_RE.test(field)) {
        rejected.push(`${idxLabel}：姓名不允许 AI 改写`);
        return;
      }
      // 事实字段（时间/链接/联系方式/所在地…）AI 不得改写；
      // 但用户在对话里明确给过的值属于「照抄用户原话」，允许写入，否则用户补充的信息无处落地。
      if (isNoRewriteField(field) && !appearsInConversation(userConvoText, after)) {
        rejected.push(`${idxLabel}：${buildFieldLabel(field)} 属于事实字段，用户未在对话中提供，AI 不能改写`);
        return;
      }
      if (looksLikeSuggestion(after)) {
        rejected.push(`${idxLabel}：改写内容像建议而非可替换的正文`);
        return;
      }
      const before = readFieldValue(content, field) ?? "";
      if (after === before.trim()) {
        rejected.push(`${idxLabel}：内容没有变化`);
        return;
      }
      edits.push({
        op: "set",
        section,
        field,
        label: buildFieldLabel(field),
        before,
        after,
        reason,
        risks: [...aiRisks, ...detectNewFacts(before, after)],
      });
      return;
    }

    if (op === "append") {
      const section = e.section;
      if (typeof section !== "string" || !(section in SETTABLE_FIELDS) || section === "basic") {
        rejected.push(`${idxLabel}：不支持新增「${String(section || "空")}」类型的条目`);
        return;
      }
      const s = section as EditSection;
      const normalized = normalizeAppendItem(s, e.item, userConvoText, userText || userConvoText);
      if (!normalized) {
        rejected.push(`${idxLabel}：新条目内容格式不正确`);
        return;
      }
      const hasContent = Object.values(normalized.item).some((v) => v);
      if (!hasContent) {
        rejected.push(`${idxLabel}：新条目没有任何内容`);
        return;
      }
      edits.push({
        op: "append",
        section: s,
        label: `新增${SECTION_LABELS[s] || s}`,
        item: normalized.item,
        itemId: normalized.itemId,
        reason,
        risks: [...aiRisks, ...normalized.risks],
      });
      return;
    }

    rejected.push(`${idxLabel}：未知操作类型（${String(op ?? "空")}）`);
  });

  return { edits, rejected };
}