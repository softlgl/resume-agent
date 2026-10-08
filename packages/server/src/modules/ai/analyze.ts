// AI 分析模块：硬规则检查 + LLM 分析 + JD 匹配（对齐 .NET 的 AiAnalyzeEndpoints / Analyzer）
// 路由：POST /ai/analyze、PATCH /ai/analyze/:resumeId/applied

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResumeContent } from "@resume-agent/shared";
import { chat, chatStream, parseJSON, isLLMAvailable, setRuntimeConfig } from "./core/llm.js";
import { ANALYSIS_SCHEMA, MATCH_SCHEMA } from "./core/schemas.js";
import { buildSystemPrompt, buildUserPrompt, sanitizeContent } from "./core/prompts.js";
import { recordCall } from "./core/call-log.js";
import { isNoRewriteField, normalizeFieldPath, pickFieldPath } from "../../services/resume-edit.js";

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
    // 字段路径有两个处理步骤：
    //   1) pickFieldPath：从 path/field/key/section 里挑真正像字段路径的那个——
    //      模型同时返回 section 与 field 时，固定顺序会取到 section 名，
    //      导致 rewrite 被「整段容器字段」规则静默清掉。
    //   2) normalizeFieldPath：收敛到简历 JSON 的真实键（模型可能返回
    //      "Works[0].Description" 或 "basic.currentstatus"）。只能做大小写归一，
    //      不能整体 toLowerCase——前端按真实键定位字段并渲染中文标签。
    const field = normalizeFieldPath(pickFieldPath(item.path, item.field, item.key, item.section, defaultField));
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
        // 与 makeIssue 用同一套挑选+归一化口径，保证「分到哪个桶」和「issue 的 field」一致
        const field = normalizeFieldPath(pickFieldPath(item.path, item.field, item.key, item.section));
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

  // 硬过滤：AI 不可能编造真实值的字段（时间、链接、联系方式、薪资、姓名等），
  // 即使 LLM 输出了 rewrite 也强行清空，防止瞎编误导前端"应用"按钮
  // 判定逻辑与对话侧共用（services/resume-edit.ts 的 isNoRewriteField）
  const stripFakeRewrites = (sections: { basic: Issue[]; works: Issue[]; projects: Issue[]; skills: Issue[] }) => {
    for (const key of Object.keys(sections) as (keyof typeof sections)[]) {
      sections[key] = sections[key].map((it) => {
        if (!it.rewrite) return it;
        if (isNoRewriteField(it.field)) {
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

export async function aiAnalyzeModule(app: FastifyInstance) {
  // 标记分析结果中的某条建议为「已应用」，落库到 Resume.analysis（供重开回看）
  app.patch("/ai/analyze/:resumeId/applied", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { resumeId } = request.params as { resumeId: string };
    const body = request.body as { section?: string; index?: number; applied?: boolean } | null;
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

    // applied 显式传 false 时取消标记（撤销 AI 修改后回滚「已应用」徽标）
    sections[section][index].applied = body?.applied !== false;
    await app.prisma.resume.update({ where: { id: resumeId }, data: { analysis: analysis as unknown as object } });
    return { ok: true };
  });

  // 分析接口
  app.post("/ai/analyze", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const parsed = analyzeBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "参数格式不正确" });

    // resumeId 与 content 至少要有一个（对齐 .NET：缺省直接 400，而不是进 analyze 后抛 TypeError）
    if (!parsed.data.resumeId && parsed.data.content == null) {
      return reply.code(400).send({ error: "参数格式不正确" });
    }

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