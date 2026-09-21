import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResumeContent } from "@resume-agent/shared";
import {
  chat,
  chatStream,
  parseJSON,
  isLLMAvailable,
  setRuntimeConfig,
  getDefaultConfig,
  listProfiles,
  refreshProfiles,
  defaultsFor,
} from "../services/llm.js";
import type { LLMProfile, LLMConfig, LLMProvider } from "../services/llm.js";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// 类型定义（前后端共用，后续可搬到 shared 包）
// ---------------------------------------------------------------------------

export type IssueSeverity = "error" | "warning" | "tip";

export interface Issue {
  severity: IssueSeverity;
  field: string;       // 如 "works[0].summary" 或 "projects[1].description"，前端据此定位
  problem: string;     // 问题描述
  suggestion?: string; // 优化建议（文字）
  rewrite?: string;    // AI 改写后的完整内容，可直接替换原字段
  applied?: boolean;   // 该建议的改写是否已被用户应用到简历
}

export interface AbilityProfile {
  tech: number; // 技术能力
  project: number; // 项目复杂度
  stability: number; // 工作稳定性
  communication: number; // 沟通能力（推断）
  education: number; // 教育背景
}

// 结构化总结（方案 B）：总体评价 + 核心优势 + 核心短板 + 优先行动建议
export interface AnalysisSummary {
  overall: string;        // 100字内总体评价
  strengths: string[];    // 2-4 条核心优势
  weaknesses: string[];   // 2-4 条核心短板
  priority: string;       // 1 条最值得优先做的事
}

export interface MatchResult {
  score: number; // 0-100
  mustHaves: { skill: string; matched: boolean }[];
  gaps: string[];
}

export interface ResumeAnalysis {
  atsScore: number;                  // ATS 友好度（硬规则可算，真实值）
  qualityScore?: number;              // 内容质量（需 LLM，没 LLM 就不填）
  sections: {
    basic: Issue[];
    works: Issue[];
    projects: Issue[];
    skills: Issue[];
  };
  summary?: AnalysisSummary;           // 结构化总结（需 LLM，没 LLM 就不填）
  abilityProfile?: AbilityProfile;    // 能力画像（需 LLM，没 LLM 就不填）
  match?: MatchResult;
  llmUsed: boolean;
  llmProvider?: string;
  reasoning?: string;   // 模型思考过程原文（随结果落库，缓存命中可回看）
  output?: string;      // 模型输出原始 JSON（随结果落库）
}

// ---------------------------------------------------------------------------
// 硬规则检查（纯本地，零成本）
// ---------------------------------------------------------------------------

function ruleChecks(content: ResumeContent): ResumeAnalysis["sections"] {
  const basic: Issue[] = [];
  const works: Issue[] = [];
  const projects: Issue[] = [];
  const skills: Issue[] = [];

  // --- 基础信息 ---
  if (!content.basic.name?.trim()) {
    basic.push({ severity: "error", field: "basic.name", problem: "未填写姓名", suggestion: "请填写真实姓名" });
  }
  if (!content.basic.phone?.trim() && !content.basic.email?.trim()) {
    basic.push({ severity: "error", field: "basic.phone", problem: "电话和邮箱都未填写", suggestion: "至少提供一种联系方式" });
  }
  if (!content.basic.title?.trim()) {
    basic.push({ severity: "warning", field: "basic.title", problem: "未填写求职意向", suggestion: "明确的求职意向能帮 HR 快速判断匹配度" });
  }

  // --- 工作经历 ---
  if (content.works.length === 0 && content.projects.length === 0) {
    works.push({ severity: "warning", field: "works", problem: "既无工作经历也无项目经历", suggestion: "至少补充一段经历来展示能力" });
  }
  for (let i = 0; i < content.works.length; i++) {
    const w = content.works[i];
    const prefix = `works[${i}]`;
    if (!w.company?.trim()) works.push({ severity: "error", field: `${prefix}.company`, problem: `第 ${i + 1} 段工作未填写公司` });
    if (!w.role?.trim()) works.push({ severity: "error", field: `${prefix}.role`, problem: `第 ${i + 1} 段工作未填写职位` });
    if (!w.start) works.push({ severity: "error", field: `${prefix}.start`, problem: `第 ${i + 1} 段工作未填开始时间` });
    if (!w.current && !w.end) works.push({ severity: "error", field: `${prefix}.end`, problem: `第 ${i + 1} 段工作未填结束时间` });
    if (w.start && w.end && w.start > w.end) {
      works.push({ severity: "error", field: `${prefix}.start`, problem: `第 ${i + 1} 段工作起止时间颠倒` });
    }
    if (w.description && w.description.length < 20) {
      works.push({ severity: "warning", field: `${prefix}.description`, problem: `第 ${i + 1} 段工作描述过短`, suggestion: "建议用 3-5 条成果来描述，包含量化数据" });
    }
  }

  // --- 项目经历 ---
  for (let i = 0; i < content.projects.length; i++) {
    const p = content.projects[i];
    const prefix = `projects[${i}]`;
    if (!p.name?.trim()) projects.push({ severity: "error", field: `${prefix}.name`, problem: `第 ${i + 1} 个项目未填写名称` });
    if (p.description && p.description.length < 20) {
      projects.push({ severity: "warning", field: `${prefix}.description`, problem: `第 ${i + 1} 个项目描述过短`, suggestion: "建议说明技术栈、你的角色和量化成果" });
    }
  }

  // --- 技能 ---
  if (content.skills.length === 0) {
    skills.push({ severity: "warning", field: "skills", problem: "未填写任何技能", suggestion: "按分类列出你的技术栈" });
  }

  return { basic, works, projects, skills };
}

// 硬规则算一个基础 ATS 分（仅完整性维度）
function ruleAtsScore(content: ResumeContent): number {
  let score = 60;
  const basic = content.basic;
  if (basic.name) score += 5;
  if (basic.phone || basic.email) score += 5;
  if (basic.title) score += 5;
  if (basic.summary && basic.summary.length > 50) score += 5;
  if (content.works.length >= 1) score += 5;
  if (content.works.length >= 3) score += 5;
  if (content.projects.length >= 1) score += 5;
  if (content.skills.length >= 2) score += 5;
  return Math.min(100, score);
}

// ---------------------------------------------------------------------------
// LLM 分析
// ---------------------------------------------------------------------------

// 期望 LLM 返回的 JSON Schema（用于强制结构化输出）
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    atsScore: { type: "integer", minimum: 0, maximum: 100 },
    qualityScore: { type: "integer", minimum: 0, maximum: 100 },
    sections: {
      type: "object",
      properties: {
        basic: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["error", "warning", "tip"] },
              field: { type: "string" },
              problem: { type: "string" },
              suggestion: { type: "string" },
              rewrite: { type: "string" },
            },
            required: ["severity", "field", "problem"],
            additionalProperties: false,
          },
        },
        works: { type: "array" },
        projects: { type: "array" },
        skills: { type: "array" },
      },
      required: ["basic", "works", "projects", "skills"],
      additionalProperties: false,
    },
    abilityProfile: {
      type: "object",
      properties: {
        tech: { type: "integer", minimum: 0, maximum: 100 },
        project: { type: "integer", minimum: 0, maximum: 100 },
        stability: { type: "integer", minimum: 0, maximum: 100 },
        communication: { type: "integer", minimum: 0, maximum: 100 },
        education: { type: "integer", minimum: 0, maximum: 100 },
      },
      required: ["tech", "project", "stability", "communication", "education"],
      additionalProperties: false,
    },
    summary: {
      type: "object",
      properties: {
        overall: { type: "string" },
        strengths: { type: "array", items: { type: "string" } },
        weaknesses: { type: "array", items: { type: "string" } },
        priority: { type: "string" },
      },
      required: ["overall", "strengths", "weaknesses", "priority"],
      additionalProperties: false,
    },
  },
  required: ["atsScore", "qualityScore", "sections", "abilityProfile"],
  additionalProperties: false,
} as const;

function buildSystemPrompt(): string {
  return `你是一名专业的招聘经理和简历优化专家。请分析候选人的简历，从以下维度给出结构化的评估：

1. **ATS 友好度（atsScore）**：机器筛选系统能否快速识别关键信息（关键词覆盖、格式规范、冗余内容）
2. **内容质量（qualityScore）**：招聘方视角，经历描述是否具体、有量化成果、用 STAR 法则、无空话套话
3. **分模块问题（sections）**：指出每个 section 存在的具体问题，按严重程度（error/warning/tip）标注。
4. **能力画像（abilityProfile）**：从技术能力、项目复杂度、工作稳定性、沟通能力（从文案推断）、教育背景五个维度打分
5. **结构化总结（summary）**：给出 100 字内总体评价（overall）、2-4 条核心优势（strengths）、2-4 条核心短板（weaknesses）、1 条最值得优先做的行动（priority）。总结要具体、有依据，避免空话。

**rewrite 字段使用规则（非常重要）**：
rewrite 是可选字段，只在"可以从现有内容推理出改写结果"时填写。分两种情况：

✅ **给 rewrite 的情况**（字段有内容，但质量差）：
- 工作/项目描述太笼统 → rewrite 写改写后的完整描述（加量化、STAR 法则、关键词）
- 技能描述太简单 → rewrite 写扩展后的版本
- 自我总结太空 → rewrite 写更具体的总结
→ rewrite 必须是完整的替换文本，不是"建议添加 XX"

❌ **不给 rewrite 的情况**（AI 不可能知道真实值）：
- 字段完全为空/缺失（如 works[0].end 结束时间、projects[0].link 项目链接、手机号缺失）
- 需要候选人提供真实外部信息（薪资、邮箱、GitHub URL、具体日期）
- 涉及主观判断（如"建议把项目移到最前面"——这是排序建议，不能用 rewrite 实现）
→ 只给 problem（问题描述）+ suggestion（操作建议），**不要填 rewrite**

**field 定位规则（同样非常重要）**：
- field 必须精确到某一个**字符串字段**，且路径里数组必须带下标，如 basic.summary、works[0].description、projects[2].description、skills[0].items。
- **禁止把整段 section 名（works/projects/educations/skills/basic，不带下标）当作 field**，也禁止给这类整段字段配 rewrite。整段是数组/对象，前端无法用一段纯文本覆盖；能重写的是段内的具体字符串字段。
- 若要改写某条经历的描述，field 必须是 works[0].description 这种带下标的路径，rewrite 才是那条描述的新文本。
- 数组或对象本身的增删（如「新增一段经历」）应写成 problem + suggestion，不给 rewrite、也不把整段名当 field。

评分标准：
- 0-40 分：明显不足
- 40-70 分：基本合格但有明显短板
- 70-90 分：较好
- 90-100 分：优秀

field 字段要用 JSON 路径格式，精确到字符串字段且数组带下标，如 basic.summary、works[0].description、projects[1].description；不要输出不带下标的整段名（如 skills）。`;
}

// 敏感字段脱敏：发送给 LLM 前替换为占位符，避免真实个人隐私外泄
// （分析只需知道"有哪些能力/经历"，不需要真实的联系方式、地址、证件号等）
// 关键：强制脱敏的键（联系方式/证件/地址/薪资/外链）在任何层级都脱敏；
// 而 name/realName 只"在 basic 节下"才当人名脱敏——projects[].name 是项目名、
// works[].name 是公司名、educations[].name 是学校名，绝不能脱敏，否则 AI 会
// 误以为是占位符并生成"把 [姓名] 替换成真实项目名"这类荒谬建议。
const FORCE_KEYS: Record<string, string> = {
  phone: "[手机号]",
  mobile: "[手机号]",
  tel: "[电话]",
  telephone: "[电话]",
  email: "[邮箱]",
  mail: "[邮箱]",
  qq: "[QQ]",
  wechat: "[微信]",
  wx: "[微信]",
  weixin: "[微信]",
  idCard: "[证件号]",
  idNumber: "[证件号]",
  avatar: "[头像]",
  photo: "[头像]",
  address: "[住址]",
  expectedSalary: "[期望薪资]",
  salary: "[薪资]",
  website: "[主页链接]",
  homepage: "[主页链接]",
  github: "[代码库链接]",
  gitee: "[代码库链接]",
  links: "[链接]",
  blog: "[博客链接]",
};
// 仅在 basic（基本信息）节下生效的人名类键
const BASIC_NAME_KEYS: Record<string, string> = { name: "[姓名]", realName: "[姓名]" };

function sanitizeContent(value: unknown, inBasic = false): any {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeContent(v, inBasic));
  }
  if (typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      const low = k.toLowerCase();
      // 进入 basic 节：其内部 name/realName 按人名脱敏
      const childIsBasic = inBasic || low === "basic";
      if (typeof v === "string" && (FORCE_KEYS[low] !== undefined || (childIsBasic && BASIC_NAME_KEYS[low] !== undefined))) {
        out[k] = FORCE_KEYS[low] ?? BASIC_NAME_KEYS[low];
      } else {
        out[k] = sanitizeContent(v, childIsBasic);
      }
    }
    return out;
  }
  return value;
}

function buildUserPrompt(content: ResumeContent, jd?: string): string {
  // 发送给 LLM 前脱敏，防止真实个人隐私随请求外泄
  const sanitized = sanitizeContent(content);
  let text = `以下是候选人的简历（JSON 格式，敏感信息已脱敏）：
\`\`\`json
${JSON.stringify(sanitized, null, 2)}
\`\`\``;
  if (jd && jd.trim()) {
    text += `

--- 目标岗位 JD ---

${jd.trim()}`;
  }
  text += `

请按 JSON Schema 格式输出分析结果。`;
  return text;
}

async function llmAnalyze(content: ResumeContent, jd?: string, onReasoning?: (delta: string) => void, onContent?: (delta: string) => void): Promise<Partial<ResumeAnalysis> | null> {
  if (!isLLMAvailable()) return null;

  // 本地累积思考过程原文，随结果一起落库，供缓存命中时回看
  let reasoningTxt = "";
  // 思考与正文共享预算；给足够大的上限，让真实卡点收敛到 profile.maxOutput（用户按模型配），
  // 避免写死小值盖掉配置导致思考耗光后 JSON 被截断。
  const text = await chatStream(
    [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(content, jd) },
    ],
    { jsonSchema: ANALYSIS_SCHEMA, temperature: 0.3, maxTokens: 262144 },
    (d) => {
      reasoningTxt += d;
      onReasoning?.(d);
    },
    onContent
  );
  if (!text) return null;

  const parsed = parseJSON<any>(text);
  if (!parsed) return null;

  // 归一化：本地模型可能返回不同的字段名（technicalAbility vs tech）
  const norm = parsed.abilityProfile ?? {};
  const ap: AbilityProfile = {
    tech: norm.tech ?? norm.technicalAbility ?? norm.technical_ability ?? 50,
    project: norm.project ?? norm.projectComplexity ?? norm.project_complexity ?? 50,
    stability: norm.stability ?? norm.workStability ?? norm.work_stability ?? 50,
    communication: norm.communication ?? norm.communicationAbility ?? norm.communication_ability ?? 50,
    education: norm.education ?? norm.educationBackground ?? norm.education_background ?? 50,
  };

  // 归一化 sections：模型可能返回三种格式
  // 格式1（扁平数组）: [{ path: "works[0].desc", issue: "...", severity: "error" }]
  // 格式2（分组对象）: { basic: [...], works: [...] }
  // 格式3（两级嵌套）: [{ section: "works", issues: [{ description: "...", severity: "warning" }] }]
  const rawSections = parsed.sections ?? parsed.issues ?? parsed.problems ?? {};
  let sectionsNormalized: { basic: Issue[]; works: Issue[]; projects: Issue[]; skills: Issue[] };

  function makeIssue(item: any, defaultField = ""): Issue {
    const field = item.path ?? item.section ?? item.field ?? item.key ?? defaultField;
    const problem = item.problem ?? item.issue ?? item.description ?? item.message ?? "";
    const suggestion = item.suggestion ?? item.fix ?? undefined;
    // 关键：提取 AI 修正后的完整内容（兼容不同模型可能用的字段名）
    const rewrite = item.rewrite ?? item.rewritten ?? item.fixed ?? item.edited ?? item.newContent ?? item.revised ?? undefined;
    const level = item.severity ?? item.level ?? "warning";
    const severity: IssueSeverity =
      level === "error" || level === "严重" ? "error" :
      level === "tip" || level === "建议" || level === "info" ? "tip" :
      "warning";
    return { severity, field, problem, suggestion, rewrite };
  }

  if (Array.isArray(rawSections)) {
    // 判断是格式1（扁平）还是格式3（两级嵌套）
    const first = rawSections[0];
    if (first && Array.isArray(first.issues)) {
      // 格式3: [{ section: "basic", issues: [...] }]
      sectionsNormalized = { basic: [], works: [], projects: [], skills: [] };
      for (const group of rawSections) {
        const section = group.section ?? group.name ?? "";
        const bucket =
          section === "works" || section === "工作经历" ? sectionsNormalized.works :
          section === "projects" || section === "项目经历" ? sectionsNormalized.projects :
          section === "skills" || section === "技能" ? sectionsNormalized.skills :
          sectionsNormalized.basic;
        for (const it of group.issues) {
          bucket.push(makeIssue(it, section));
        }
      }
    } else {
      // 格式1: 扁平数组
      sectionsNormalized = { basic: [], works: [], projects: [], skills: [] };
      for (const item of rawSections) {
        const field = item.path ?? item.section ?? item.field ?? item.key ?? "";
        const issue = makeIssue(item);
        if (field.startsWith("basic") || field.startsWith("基本")) sectionsNormalized.basic.push(issue);
        else if (field.startsWith("works") || field.startsWith("工作")) sectionsNormalized.works.push(issue);
        else if (field.startsWith("projects") || field.startsWith("项目")) sectionsNormalized.projects.push(issue);
        else if (field.startsWith("skills") || field.startsWith("技能")) sectionsNormalized.skills.push(issue);
        else sectionsNormalized.basic.push(issue);
      }
    }
  } else {
    // 格式2: 分组对象
    sectionsNormalized = {
      basic: (rawSections.basic ?? rawSections.基本信息 ?? rawSections.basicInfo ?? []).map((i: any) => makeIssue(i, "basic")),
      works: (rawSections.works ?? rawSections.工作经历 ?? rawSections.workExp ?? []).map((i: any) => makeIssue(i, "works")),
      projects: (rawSections.projects ?? rawSections.项目经历 ?? []).map((i: any) => makeIssue(i, "projects")),
      skills: (rawSections.skills ?? rawSections.技能 ?? []).map((i: any) => makeIssue(i, "skills")),
    };
  }

  // 硬过滤：AI 不可能编造真实值的字段（时间、链接、联系方式、薪资等），
  // 即使 LLM 输出了 rewrite 也强行清空，防止瞎编误导前端"应用"按钮
  const NO_REWRITE_PATTERNS = [
    /\.(start|end|link|url|github|gitee|phone|mobile|tel|email|mail|qq|wechat|wx|address|location|salary|expect|expectedSalary|birthday|birth|age|gender|avatar|photo|image|portfolio|blog|website|homepage|doubao|zhihu|bilibili|juejin|csdn|leetcode|hotjob|jobPosition|jobLevel)$/i,
  ];
  const stripFakeRewrites = (sections: { basic: Issue[]; works: Issue[]; projects: Issue[]; skills: Issue[] }) => {
    for (const key of Object.keys(sections) as (keyof typeof sections)[]) {
      sections[key] = sections[key].map((it) => {
        if (!it.rewrite) return it;
        if (NO_REWRITE_PATTERNS.some((re) => re.test(it.field))) {
          return { ...it, rewrite: undefined };
        }
        // 整段容器字段（field 不含下标 [ 或字段路径 .，如 "works"/"projects"/"skills"/"basic"）：
        // 这些顶层值是数组/对象，rewrite 是纯文本，一旦应用会把容器覆写成字符串导致前端崩溃。
        // 若 AI 想重写整条，应给出带下标的字段（如 works[0].description）；否则只给建议、不给 rewrite。
        if (!/[\[\.]/.test(it.field)) {
          return { ...it, rewrite: undefined };
        }
        return it;
      });
    }
    return sections;
  };

  // 硬过滤：如果 rewrite 内容明显是建议式文字（如"建议添加..."、"可以补充..."），也清空
  const stripSuggestionRewrites = (sections: { basic: Issue[]; works: Issue[]; projects: Issue[]; skills: Issue[] }) => {
    const SUGGESTION_PATTERNS = [/^建议/, /^可以/, /^推荐/, /^应该/, /^最好/, /需补充/, /需添加/, /请填写/, /请补充/];
    for (const key of Object.keys(sections) as (keyof typeof sections)[]) {
      sections[key] = sections[key].map((it) => {
        if (!it.rewrite) return it;
        if (SUGGESTION_PATTERNS.some((re) => re.test(it.rewrite!.trim()))) {
          return { ...it, rewrite: undefined };
        }
        return it;
      });
    }
    return sections;
  };

  sectionsNormalized = stripFakeRewrites(sectionsNormalized);
  sectionsNormalized = stripSuggestionRewrites(sectionsNormalized);

  // 结构化总结（方案 B）：对模型可能使用的不同字段名做兜底
  const sRaw = parsed.summary ?? parsed.overview ?? parsed.conclusion ?? null;
  const s = sRaw && typeof sRaw === "object"
    ? {
        overall: sRaw.overall ?? sRaw.overview ?? sRaw.summary ?? "",
        strengths: Array.isArray(sRaw.strengths) ? sRaw.strengths : [],
        weaknesses: Array.isArray(sRaw.weaknesses) ? sRaw.weaknesses : [],
        priority: sRaw.priority ?? sRaw.action ?? sRaw.recommendation ?? "",
      }
    : undefined;

  return {
    atsScore: typeof parsed.atsScore === "number" ? parsed.atsScore : undefined,
    qualityScore: typeof parsed.qualityScore === "number" ? parsed.qualityScore : undefined,
    sections: {
      basic: Array.isArray(sectionsNormalized.basic) ? sectionsNormalized.basic : [],
      works: Array.isArray(sectionsNormalized.works) ? sectionsNormalized.works : [],
      projects: Array.isArray(sectionsNormalized.projects) ? sectionsNormalized.projects : [],
      skills: Array.isArray(sectionsNormalized.skills) ? sectionsNormalized.skills : [],
    },
    summary: s,
    abilityProfile: ap,
    reasoning: reasoningTxt,
    output: text,
  };
}

// ---------------------------------------------------------------------------
// 合并硬规则 + LLM 结果
// ---------------------------------------------------------------------------

function mergeIssues(a: Issue[], b: Issue[]): Issue[] {
  // 简单合并：硬规则问题在前，LLM 建议在后；同一 field 不重复
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const it of [...a, ...b]) {
    const key = `${it.field}|${it.problem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function analyze(content: ResumeContent, jd?: string, onReasoning?: (delta: string) => void, onContent?: (delta: string) => void): Promise<ResumeAnalysis> {
  const rule = ruleChecks(content);
  const ruleAts = ruleAtsScore(content);

  const llm = await llmAnalyze(content, jd, onReasoning, onContent);
  const usedLLM = !!llm;

  const sections: ResumeAnalysis["sections"] = {
    basic: mergeIssues(rule.basic, llm?.sections?.basic ?? []),
    works: mergeIssues(rule.works, llm?.sections?.works ?? []),
    projects: mergeIssues(rule.projects, llm?.sections?.projects ?? []),
    skills: mergeIssues(rule.skills, llm?.sections?.skills ?? []),
  };

  const atsScore = llm?.atsScore ?? ruleAts;

  return {
    atsScore,
    qualityScore: llm?.qualityScore,
    sections,
    summary: llm?.summary,
    abilityProfile: llm?.abilityProfile,
    llmUsed: usedLLM,
    llmProvider: usedLLM ? (process.env.LLM_PROVIDER || "unknown") : undefined,
    reasoning: llm?.reasoning,
    output: llm?.output,
  };
}

// ---------------------------------------------------------------------------
// JD 匹配（可选，单独端点，和基础分析解耦）
// ---------------------------------------------------------------------------

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    mustHaves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          skill: { type: "string" },
          matched: { type: "boolean" },
        },
        required: ["skill", "matched"],
        additionalProperties: false,
      },
    },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["score", "mustHaves", "gaps"],
  additionalProperties: false,
} as const;

async function jdMatch(content: ResumeContent, jd: string): Promise<MatchResult | null> {
  if (!isLLMAvailable()) return null;
  const result = await chat(
    [
      {
        role: "system",
        content:
          "你是招聘专家。请对比候选人简历和目标岗位 JD，判断匹配度。先从 JD 提取 5-10 个硬性要求（技能/经验/学历），逐条判断简历是否满足，然后列出明确的差距项。",
      },
      {
        role: "user",
        content: `简历：\n\`\`\`json\n${JSON.stringify(sanitizeContent(content), null, 2)}\n\`\`\`\n\nJD：\n${jd}`,
      },
    ],
    { jsonSchema: MATCH_SCHEMA, temperature: 0.2 }
  );
  if (!result) return null;
  return parseJSON<MatchResult>(result.text);
}

// ---------------------------------------------------------------------------
// Fastify 模块注册
// ---------------------------------------------------------------------------

const analyzeBodySchema = z.object({
  resumeId: z.string().optional(),
  content: z.any() as unknown as z.ZodType<ResumeContent>,
  jd: z.string().optional(),
  // force=true 时忽略已有缓存，强制重新分析并覆盖（用于前端「重新分析」按钮）
  force: z.boolean().optional(),
});

function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}***${key.slice(-2)}`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

/** 从数据库读取模型配置并刷新 llm 模块内存快照（全局共享，无 userId） */
async function syncProfiles(prisma: PrismaClient) {
  // 首次启动且尚无任何模型记录时，把 .env/默认值种入一条默认模型并置为激活，
  // 保证前端模型列表始终有可见、可用的默认模型（后续仍可正常编辑/删除/新增）
  const count = await prisma.aiModelProfile.count();
  if (count === 0) {
    const seed = getDefaultConfig();
    await prisma.aiModelProfile.create({
      data: {
        name: "默认模型",
        provider: seed.provider,
        apiKey: seed.apiKey,
        baseUrl: seed.baseUrl,
        model: seed.model,
        maxContext: seed.maxContext,
        maxOutput: seed.maxOutput,
        active: true,
      },
    });
  }
  const rows = await prisma.aiModelProfile.findMany({ orderBy: { createdAt: "asc" } });
  const profiles: LLMProfile[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider as LLMProfile["provider"],
    apiKey: r.apiKey,
    baseUrl: r.baseUrl,
    model: r.model,
    maxContext: r.maxContext,
    maxOutput: r.maxOutput,
  }));
  refreshProfiles(profiles, rows.find((r) => r.active)?.id ?? null);
}

function buildConfigPayload(profiles: LLMProfile[], activeId: string | null, cfg: LLMConfig) {
  return {
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      maxContext: p.maxContext,
      maxOutput: p.maxOutput,
      apiKeyMasked: maskApiKey(p.apiKey),
      active: p.id === activeId,
    })),
    activeId,
    // 当前生效配置摘要（可能来自 .env 或激活的 profile）
    config: {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKeyMasked: maskApiKey(cfg.apiKey),
    },
    available: isLLMAvailable(),
  };
}

/** 记录一次 AI 调用日志（保留全部历史，前端只展示最新一条） */
async function recordCall(
  prisma: PrismaClient,
  userId: string,
  result: ResumeAnalysis,
  opts: { kind?: "analyze" | "import"; resumeId?: string | null } = {}
) {
  try {
    const cfg = getDefaultConfig();
    await prisma.llmCallLog.create({
      data: {
        userId,
        kind: opts.kind ?? "analyze",
        resumeId: opts.resumeId ?? null,
        provider: cfg.provider,
        model: cfg.model,
        ok: true,
        reasoning: result.reasoning ?? null,
        output: result.output ?? null,
      },
    });
  } catch (err) {
    console.error("[AI] 记录调用日志失败:", err);
  }
}

export async function aiModule(app: FastifyInstance) {
  // 启动时从数据库加载模型配置到内存快照
  await syncProfiles(app.prisma);

  // 最近一次 AI 调用日志（供前端展示，数据保留全量历史）
  app.get("/ai/calls/latest", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const row = await app.prisma.llmCallLog.findFirst({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return { call: null };
    return {
      call: {
        id: row.id,
        kind: row.kind,
        resumeId: row.resumeId,
        provider: row.provider,
        model: row.model,
        ok: row.ok,
        reasoning: row.reasoning,
        output: row.output,
        createdAt: row.createdAt.toISOString(),
      },
    };
  });

  // 健康检查
  app.get("/ai/health", async () => ({
    llmAvailable: isLLMAvailable(),
    config: getDefaultConfig(),
  }));

  // 获取配置列表（模型 profiles + 当前激活）+ 当前生效配置摘要（前端初始化设置面板）
  app.get("/ai/config", async () => {
    await syncProfiles(app.prisma);
    const { profiles, activeId } = listProfiles();
    return buildConfigPayload(profiles, activeId, getDefaultConfig());
  });

  // 增删改选模型 profile：body { action: 'add'|'update'|'remove'|'setActive'|'clear', ... }
  app.post("/ai/config", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const body = (request.body ?? {}) as any;
    const action = typeof body?.action === "string" ? body.action : "add";
    const prisma = app.prisma;
    switch (action) {
      case "add": {
        if (!body?.provider) return reply.code(400).send({ error: "provider 必填" });
        const provider = body.provider as LLMProvider;
        const def = defaultsFor(provider);
        const count = await prisma.aiModelProfile.count();
        await prisma.aiModelProfile.create({
          data: {
            name: body.name?.trim() || (body.model?.trim() ? `${provider} · ${body.model.trim()}` : provider),
            provider,
            apiKey: body.apiKey ?? "",
            baseUrl: body.baseUrl?.trim() || def.baseUrl,
            model: body.model?.trim() || def.model,
            maxContext: body.maxContext ?? def.maxContext,
            maxOutput: body.maxOutput ?? def.maxOutput,
            active: count === 0, // 第一条自动激活
          },
        });
        break;
      }
      case "update": {
        if (!body?.id) return reply.code(400).send({ error: "id 必填" });
        const t = await prisma.aiModelProfile.findUnique({ where: { id: body.id } });
        if (!t) return reply.code(404).send({ error: "模型不存在" });
        const provider = (body.provider as LLMProvider) || (t.provider as LLMProvider);
        const def = defaultsFor(provider);
        await prisma.aiModelProfile.update({
          where: { id: body.id },
          data: {
            name: body.name?.trim() || t.name,
            provider,
            apiKey: body.apiKey !== undefined ? body.apiKey : t.apiKey,
            baseUrl: body.baseUrl?.trim() || (body.baseUrl !== undefined ? def.baseUrl : t.baseUrl),
            model: body.model?.trim() || (body.model !== undefined ? def.model : t.model),
            maxContext: body.maxContext !== undefined ? body.maxContext : t.maxContext,
            maxOutput: body.maxOutput !== undefined ? body.maxOutput : t.maxOutput,
          },
        });
        break;
      }
      case "remove": {
        if (!body?.id) return reply.code(400).send({ error: "id 必填" });
        const t = await prisma.aiModelProfile.findUnique({ where: { id: body.id } });
        if (!t) return reply.code(404).send({ error: "模型不存在" });
        await prisma.aiModelProfile.delete({ where: { id: body.id } });
        // 删除激活项时让第一条成为新的激活
        if (t.active) {
          const next = await prisma.aiModelProfile.findFirst({ orderBy: { createdAt: "asc" } });
          if (next) await prisma.aiModelProfile.update({ where: { id: next.id }, data: { active: true } });
        }
        break;
      }
      case "setActive": {
        if (!body?.id) return reply.code(400).send({ error: "id 必填" });
        const t = await prisma.aiModelProfile.findUnique({ where: { id: body.id } });
        if (!t) return reply.code(404).send({ error: "模型不存在" });
        await prisma.$transaction([
          prisma.aiModelProfile.updateMany({ where: { active: true }, data: { active: false } }),
          prisma.aiModelProfile.update({ where: { id: body.id }, data: { active: true } }),
        ]);
        break;
      }
      case "clear": {
        await prisma.aiModelProfile.deleteMany({});
        break;
      }
      default:
        return reply.code(400).send({ error: `未知 action: ${action}` });
    }
    await syncProfiles(prisma);
    const cur = listProfiles();
    return buildConfigPayload(cur.profiles, cur.activeId, getDefaultConfig());
  });

  // 清空所有模型 profile（回到 .env 逻辑）
  app.delete("/ai/config", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    await app.prisma.aiModelProfile.deleteMany({});
    await syncProfiles(app.prisma);
    const cur = listProfiles();
    return buildConfigPayload(cur.profiles, cur.activeId, getDefaultConfig());
  });

  // 标记分析结果中的某条建议为「已应用」，落库到 Resume.analysis（供重开回看）
  app.patch("/ai/analyze/:resumeId/applied", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { resumeId } = request.params as { resumeId: string };
    const body = request.body as { section?: string; index?: number } | null;
    const section = body?.section;
    const index = body?.index;
    if (!section || index === undefined) return reply.code(400).send({ error: "section 与 index 必填" });

    const resume = await app.prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume || resume.userId !== request.userId) return reply.code(404).send({ error: "简历不存在" });

    const analysis = (resume.analysis ?? {}) as any;
    const sections = analysis?.sections;
    if (
      !sections || !["basic", "works", "projects", "skills"].includes(section) ||
      !Array.isArray(sections[section]) || !sections[section][index] ||
      typeof sections[section][index] !== "object"
    ) {
      return reply.code(400).send({ error: "无效的 section / index" });
    }

    sections[section][index].applied = true;
    await app.prisma.resume.update({ where: { id: resumeId }, data: { analysis: analysis as unknown as object } });
    return { ok: true };
  });

  // 分析接口
  app.post("/ai/analyze", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const parsed = analyzeBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数格式不正确" });

    // 支持请求级 config 覆盖（前端面板先 POST /ai/config，再调 analyze；也可以直接带 config 字段）
    const runtimeCfg = (request.body as any)?.config;
    if (runtimeCfg && typeof runtimeCfg === "object") {
      setRuntimeConfig(runtimeCfg);
    }

    let content: ResumeContent;
    if (parsed.data.resumeId) {
      const resume = await app.prisma.resume.findFirst({
        where: { id: parsed.data.resumeId, userId: request.userId },
      });
      if (!resume) return reply.code(404).send({ error: "简历不存在" });
      content = resume.content as unknown as ResumeContent;

      // 基础分析（无 JD）：若有已存的缓存结果且未要求强制刷新 → 直接返回，不重复消耗 LLM
      if (!parsed.data.jd?.trim() && !parsed.data.force && resume.analysis) {
        if (!isStreamReq(request)) return { analysis: resume.analysis as unknown as ResumeAnalysis };
        reply.hijack();
        const raw = reply.raw;
        raw.setHeader("Content-Type", "text/event-stream");
        const send = (event: string, data: unknown) =>
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send("result", { analysis: resume.analysis as unknown as ResumeAnalysis });
        send("done", { ok: true });
        raw.end();
        return reply;
      }
    } else {
      content = parsed.data.content;
    }

    // 流式 SSE：reasoning(思考过程,逐字) → result(最终分析) → done；非流式请求仍返回 JSON
    if (!isStreamReq(request)) {
      const result = await analyze(content, parsed.data.jd);
      if (parsed.data.jd?.trim()) {
        const match = await jdMatch(content, parsed.data.jd.trim());
        if (match) result.match = match;
      }
      if (result.llmUsed) await recordCall(app.prisma, request.userId, result, { resumeId: parsed.data.resumeId ?? null });
      if (parsed.data.resumeId && !parsed.data.jd?.trim()) {
        await app.prisma.resume.update({
          where: { id: parsed.data.resumeId },
          data: { analysis: result as unknown as object },
        });
      }
      return { analysis: result };
    }

    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache");
    raw.setHeader("Connection", "keep-alive");
    const send = (event: string, data: unknown) =>
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const result = await analyze(content, parsed.data.jd, (d) => send("reasoning", { delta: d }), (d) => send("content", { delta: d }));
    if (result.llmUsed) await recordCall(app.prisma, request.userId, result, { resumeId: parsed.data.resumeId ?? null });

    if (parsed.data.jd?.trim()) {
      const match = await jdMatch(content, parsed.data.jd.trim());
      if (match) result.match = match;
    }

    // 基础分析结果落库，供下次打开复用（JD 匹配不落库）
    if (parsed.data.resumeId && !parsed.data.jd?.trim()) {
      await app.prisma.resume.update({
        where: { id: parsed.data.resumeId },
        data: { analysis: result as unknown as object },
      });
    }

    send("result", { analysis: result });
    send("done", { ok: true });
    raw.end();
    return reply;
  });
}

// 判断是否为流式请求：前端带 streaming=true 则走 SSE
function isStreamReq(request: any): boolean {
  const body = request?.body as { streaming?: boolean } | undefined;
  return body?.streaming === true;
}
