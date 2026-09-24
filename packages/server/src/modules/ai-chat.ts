// AI 简历对话模块
// - 会话 CRUD + 多轮对话（SSE 流式）
// - AI 产出的修改建议经 services/resume-edit.ts 权威校验后下发给前端
// - 统一修订账本（AiRevision）：对话侧与分析侧共用的撤销依据
// 设计约束：本模块不提供任何「直接改简历字段」的接口，写入永远由前端 applyEdit 完成。

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type {
  AuditTask,
  ChatMessageRecord,
  ChatSessionMeta,
  ResumeContent,
  ResumeEdit,
  EditSection,
} from "@resume-agent/shared";
import { chatStream, getLLMConfig, isLLMAvailable, parseJSON } from "../services/llm.js";
import type { ChatMessage } from "../services/llm.js";
import { sanitizeContent, recordCall } from "./ai.js";
import {
  buildFieldLabel,
  checkAppendRequired,
  parseFieldPath,
  readFieldValue,
  sectionLabel,
  validateEdits,
  SETTABLE_FIELDS,
} from "../services/resume-edit.js";

// ---------------------------------------------------------------------------
// LLM 输出契约
// schema 保持扁平（DeepSeek 只有 json_object 模式，复杂 schema 会被忽略）
// ---------------------------------------------------------------------------

const CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    asks: { type: "array", items: { type: "string" } },
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
  required: ["reply", "asks", "edits"],
};

const CHAT_SYSTEM_PROMPT = `你是资深简历顾问，正在帮用户修改「当前这一份」简历。你只输出 JSON，不要输出任何解释性文字或 markdown 代码块。

【改写铁律】
1. 绝对不得新增用户没有提供的事实：数字、百分比、公司名、学校名、技术名词、时间、奖项。
2. 以下字段只能「照抄用户原话」，不得自己生成：时间(start/end)、链接(link/url)、联系方式(phone/email)、所在地(location)、薪资(expectedSalary)、出生年月(birthday)、性别(gender)。姓名(name)任何情况都不许写进 edits。
3. 改写只能做：语序调整、动词强化、去掉口语化表达、把已有事实重组为 STAR 结构、补齐标点与量词。
4. 某个字段没有可改的东西，就不要出现在 edits 里。

【输出结构】
{
  "reply": "给用户看的回复，可用少量 markdown（**粗体**、- 列表）",
  "asks": ["需要用户补充的信息点，每条一个短问句，最多 4 条"],
  "edits": [
    { "op": "set", "field": "works[0].description", "after": "改写后的完整内容", "reason": "为什么这么改", "risks": [] },
    { "op": "append", "section": "works", "item": { "company": "公司名", "role": "职位", "start": "开始时间", "end": "结束时间或至今", "description": "职责与产出" }, "reason": "为什么新增", "risks": [] },
    { "op": "append", "section": "projects", "item": { "name": "项目名称", "company": "所属公司", "role": "你的角色", "start": "开始时间", "end": "结束时间", "description": "项目内容与成果" }, "reason": "为什么新增", "risks": [] }
  ]
}

【edits 的硬性要求】
- edits 里绝对不要出现「建议添加…」「可以补充…」这类文字；要么给出可直接替换的完整正文（op=set），要么把要问的点放进 asks。
- op=set 的 field 必须是「section[下标].字段名」的完整路径，且该条目必须已经存在。
- op=append 用于「用户描述的是一段新经历」。item 里只填用户明确说过的内容；用户没说过的一律留空字符串，绝不编造。
- 时间（start/end）、链接（link）只有用户原话里出现过才能填，且必须照抄用户给的写法（例：用户说「2023年3月入职」就填 "2023年3月"）；用户没说就留空，由用户在卡片里补。

【引导补全：用户给了一段新经历时】
1. 先判断属于哪个 section：
   - works = 在某公司任职（公司、职位、在职时间、职责与产出）
   - projects = 某个具体项目（项目名称、角色、技术/方法、职责与成果）
   - 用户同时给了任职信息和项目信息时，必须**同时**输出两条 append（一条 works、一条 projects），不要只处理其中一种。
   - 用户给的是一段新经历但还不完整时，也要先用 op=append 把已知信息落成条目，缺的部分放进 asks。
2. 各 section 的必填字段（缺失就必须写进 asks，并指明属于哪一段经历）：
   - works：公司名称、职位、开始时间（结束时间/是否至今可选）
   - projects：项目名称（其余可选，但角色、时间、成果尽量追问）
   - educations：学校、开始时间
   - skills：技能分类、技能内容
3. asks 每条一个短问句，带上 section 与条目名称做限定，例：「你在这段 XX 项目里的角色是？（项目经历）」「这段 A 公司经历的结束时间是什么时候？（工作经历）」。
4. 一次最多 4 条 asks，优先问必填缺口；用户已回答过的不要再问。
5. 输出前自查一遍：用户这段话里，属于「任职」的信息是否都进了 works 的 append？属于「项目」的信息是否都进了 projects 的 append？只要用户提到了某个项目/系统/平台/产品，就必须有对应的 projects 条目（信息不全也要先建条目，缺的写进 asks），不允许把它塞进 works.description 就算了。

【其他】
- 若给了焦点字段，优先围绕焦点回答，但不要忽略用户的实际提问。
- 若给了目标岗位 JD，改写与建议需向 JD 靠拢，但仍不得编造。
- 回复用中文，语气专业、简洁。`;

// ---------------------------------------------------------------------------
// 上下文裁剪预算
// ---------------------------------------------------------------------------

const HISTORY_MAX_COUNT = 12; // 最多带最近 12 条历史
const HISTORY_MSG_MAX_CHARS = 2000; // 单条历史消息字符上限

function contextCharBudget(): number {
  const cfg = getLLMConfig();
  // maxContext 是 token 数；中文约 1 token/字，留 45% 给历史并按 1.5 倍保守放大
  const maxContext = cfg?.maxContext ?? 32768;
  return Math.floor(maxContext * 0.45 * 1.5);
}

function trimHistory(rows: { role: string; content: string }[], maxChars: number): ChatMessage[] {
  const recent = rows.slice(-HISTORY_MAX_COUNT);
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    const c =
      r.content.length > HISTORY_MSG_MAX_CHARS
        ? `${r.content.slice(0, HISTORY_MSG_MAX_CHARS)}…（已截断）`
        : r.content;
    if (out.length > 0 && used + c.length > maxChars) break;
    out.unshift({ role: r.role === "assistant" ? "assistant" : "user", content: c });
    used += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function parseFocus(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function sessionToMeta(s: any): ChatSessionMeta {
  const preview = s?.messages?.[0]?.content as string | undefined;
  return {
    id: s.id,
    resumeId: s.resumeId,
    title: s.title,
    focus: parseFocus(s.focus),
    jd: s.jd ?? null,
    messageCount: s._count?.messages ?? 0,
    lastMessageAt: s.lastMessageAt instanceof Date ? s.lastMessageAt.toISOString() : String(s.lastMessageAt),
    ...(preview ? { preview: preview.slice(0, 60) } : {}),
  };
}

function messageToRecord(r: any): ChatMessageRecord {
  return {
    id: r.id,
    sessionId: r.sessionId,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    edits: (r.edits as ResumeEdit[] | null) ?? null,
    appliedIndexes: Array.isArray(r.appliedIndexes) ? (r.appliedIndexes as number[]) : [],
    reasoning: r.reasoning ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

const SESSION_WITH_LAST_MESSAGE = {
  _count: { select: { messages: true } },
  messages: { orderBy: { createdAt: "desc" }, take: 1, select: { content: true } },
} as const;

// ---------------------------------------------------------------------------
// 体检待办 + 开场消息（纯本地拼装，不调 LLM）
// ---------------------------------------------------------------------------

function buildAuditTasks(analysis: any): AuditTask[] {
  if (!analysis || typeof analysis !== "object") return [];
  const tasks: AuditTask[] = [];
  const sections = analysis.sections ?? {};
  for (const key of ["basic", "works", "projects", "skills"] as const) {
    const list = Array.isArray(sections[key]) ? sections[key] : [];
    list.forEach((it: any, i: number) => {
      if (!it || typeof it !== "object") return;
      if (it.applied === true) return; // 已处理过的跳过
      const sev = it.severity === "error" ? "error" : it.severity === "warning" ? "warning" : "tip";
      if (sev === "tip") return;
      const problem = String(it.problem ?? "").trim();
      if (!problem) return;
      const field = typeof it.field === "string" && it.field ? it.field : undefined;
      tasks.push({
        id: `issue:${key}:${i}`,
        kind: "issue",
        severity: sev,
        title: problem,
        ...(field ? { field } : {}),
        prompt: `帮我处理这个问题：${problem}`,
      });
    });
  }
  const gaps = Array.isArray(analysis.match?.gaps) ? analysis.match.gaps : [];
  gaps.forEach((g: unknown, i: number) => {
    const text = String(g ?? "").trim();
    if (!text) return;
    tasks.push({
      id: `gap:${i}:${text}`,
      kind: "gap",
      severity: "tip",
      title: `JD 要求但简历未体现：${text}`,
      prompt: `JD 要求「${text}」，帮我在简历里体现`,
    });
  });
  return tasks.slice(0, 20);
}

function buildOpeningMessage(analysis: any, tasks: AuditTask[]): string {
  if (!analysis || typeof analysis !== "object") {
    return [
      "你好，我是你的简历顾问。",
      "",
      "这份简历还没有做过 AI 分析，你可以先跑一次「AI 分析」拿到体检清单；",
      "也可以直接把想补充的经历贴给我，我帮你整理成条目。",
    ].join("\n");
  }
  const ats = typeof analysis.atsScore === "number" ? analysis.atsScore : null;
  const errors = tasks.filter((t) => t.kind === "issue" && t.severity === "error").length;
  const warnings = tasks.filter((t) => t.kind === "issue" && t.severity === "warning").length;
  const gaps = tasks.filter((t) => t.kind === "gap").length;

  const head =
    `我已经看过这份简历了。${ats !== null ? `当前 ATS 友好度 **${ats}** 分，` : ""}` +
    `识别到 **${errors} 个错误**、**${warnings} 处可优化**${gaps ? `、**${gaps} 项 JD 缺口**` : ""}。`;

  const lines = [head];
  const top = tasks.slice(0, 3);
  if (top.length) {
    lines.push("", "最值得先处理的几件事：");
    top.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.title}${t.field ? `（${buildFieldLabel(t.field)}）` : ""}`);
    });
  }
  lines.push("", "你可以：");
  lines.push("- 直接把要补充的经历贴给我，我帮你整理成条目");
  if (tasks.length) lines.push("- 点下面的待办让我逐个处理");
  lines.push("- 或者问我任何关于这份简历的问题");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 用户消息拼装：简历 JSON + @引用 + 焦点 + 待办 + JD
// ---------------------------------------------------------------------------

/** 只保留长文本字段的精简版简历，用于简历本身超出上下文预算时降级 */
function compactResume(content: any) {
  return {
    basic: {
      name: content?.basic?.name,
      title: content?.basic?.title,
      summary: content?.basic?.summary,
      currentStatus: content?.basic?.currentStatus,
      workYears: content?.basic?.workYears,
    },
    works: (content?.works ?? []).map((w: any) => ({
      company: w?.company,
      role: w?.role,
      start: w?.start,
      end: w?.end,
      description: w?.description,
    })),
    projects: (content?.projects ?? []).map((p: any) => ({
      name: p?.name,
      role: p?.role,
      description: p?.description,
    })),
    skills: (content?.skills ?? []).map((s: any) => ({ category: s?.category, items: s?.items })),
  };
}

const REF_RE = /@(basic|works|educations|projects|skills)(?:\[(\d+)\])?(?:\.([A-Za-z0-9_]+))?/g;

/** 解析用户文本里的 @works[0].description 引用，取出对应内容 */
function extractRefs(userText: string, content: ResumeContent): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(userText)) !== null) {
    const path = m[0].slice(1);
    if (seen.has(path)) continue;
    seen.add(path);
    const parsed = parseFieldPath(path);
    if (!parsed) continue;
    let value = "";
    if (parsed.key) {
      value = readFieldValue(content, path) ?? "";
    } else if (parsed.index !== null) {
      const list = content[parsed.section] as unknown as unknown[];
      value = JSON.stringify(list?.[parsed.index] ?? null, null, 2);
    } else {
      value = JSON.stringify(content[parsed.section] ?? null, null, 2);
    }
    if (!value) continue;
    out.push({ label: buildFieldLabel(path), value: value.slice(0, 2000) });
    if (out.length >= 5) break;
  }
  return out;
}

function buildChatUserContent(opts: {
  content: ResumeContent;
  focus: string[];
  tasks: AuditTask[];
  jd: string | null;
  userText: string;
  refs: { label: string; value: string }[];
}): string {
  const budget = contextCharBudget();
  const sanitized = sanitizeContent(opts.content);
  const pretty = JSON.stringify(sanitized, null, 2);
  const json = pretty.length <= budget ? pretty : JSON.stringify(compactResume(sanitized), null, 2);

  const parts: string[] = [`当前简历（敏感信息已脱敏）：\n\`\`\`json\n${json}\n\`\`\``];
  if (opts.refs.length) {
    parts.push(
      `用户引用的内容：\n${opts.refs.map((r) => `· ${r.label}：\n${r.value}`).join("\n")}`
    );
  }
  if (opts.focus.length) {
    parts.push(`焦点：${opts.focus.map((f) => `${buildFieldLabel(f)}（${f}）`).join("、")}`);
  }
  if (opts.tasks.length) {
    parts.push(
      `体检待办（系统已识别的待完善项）：\n${opts.tasks
        .map((t) => `- [${t.severity}] ${t.title}${t.field ? `（${t.field}）` : ""}`)
        .join("\n")}`
    );
  }
  if (opts.jd?.trim()) parts.push(`--- 目标岗位 JD ---\n${opts.jd.trim()}`);
  parts.push(`用户提问：\n${opts.userText}`);
  return parts.join("\n\n");
}

/** 把 AI 回复与 asks 合并成一条可读的 assistant 内容 */
function composeAssistantContent(replyText: string, asks: string[]): string {
  const blocks: string[] = [];
  if (replyText) blocks.push(replyText);
  if (asks.length) blocks.push(`还需要你补充：\n${asks.map((a) => `- ${a}`).join("\n")}`);
  return blocks.join("\n\n") || "（AI 未返回文本回复）";
}

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

export async function aiChatModule(app: FastifyInstance) {
  const prisma: PrismaClient = app.prisma;

  /** 校验简历归属，返回简历行；不通过时返回 null 并已发送响应 */
  async function requireResume(reply: any, resumeId: string, userId: string) {
    const resume = await prisma.resume.findFirst({ where: { id: resumeId, userId } });
    if (!resume) {
      reply.code(404).send({ error: "简历不存在" });
      return null;
    }
    return resume;
  }

  // -------------------------------------------------------------------------
  // 1. 会话列表
  // -------------------------------------------------------------------------
  app.get("/ai/chat/sessions", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { resumeId, archived } = request.query as { resumeId?: string; archived?: string };
    if (!resumeId) return reply.code(400).send({ error: "resumeId 必填" });
    const resume = await requireResume(reply, resumeId, request.userId);
    if (!resume) return reply;

    const rows = await prisma.aiChatSession.findMany({
      where: {
        resumeId,
        userId: request.userId,
        archived: archived === "true",
      },
      orderBy: { lastMessageAt: "desc" },
      include: SESSION_WITH_LAST_MESSAGE,
    });
    return { sessions: rows.map(sessionToMeta) };
  });

  // -------------------------------------------------------------------------
  // 2. 新建会话（可选插入本地拼装的开场消息）
  // -------------------------------------------------------------------------
  app.post("/ai/chat/sessions", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const body = (request.body ?? {}) as {
      resumeId?: string;
      title?: string;
      focus?: string[];
      jd?: string;
      withOpening?: boolean;
    };
    if (!body.resumeId) return reply.code(400).send({ error: "resumeId 必填" });
    const resume = await requireResume(reply, body.resumeId, request.userId);
    if (!resume) return reply;

    const focus = Array.isArray(body.focus) ? body.focus.filter((f) => typeof f === "string") : [];
    const session = await prisma.aiChatSession.create({
      data: {
        resumeId: body.resumeId,
        userId: request.userId,
        title: (body.title || "新对话").slice(0, 60),
        focus: focus.length ? JSON.stringify(focus) : null,
        jd: body.jd?.trim() || null,
        lastMessageAt: new Date(),
      },
    });

    const tasks = buildAuditTasks(resume.analysis);
    const messages: ChatMessageRecord[] = [];
    if (body.withOpening) {
      const opening = await prisma.aiChatMessage.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          content: buildOpeningMessage(resume.analysis, tasks),
          appliedIndexes: [] as unknown as object,
        },
      });
      messages.push(messageToRecord(opening));
    }

    const full = await prisma.aiChatSession.findUnique({
      where: { id: session.id },
      include: SESSION_WITH_LAST_MESSAGE,
    });
    return { session: sessionToMeta(full ?? session), messages, tasks };
  });

  // -------------------------------------------------------------------------
  // 3. 会话详情（最近 30 条消息 + 体检待办）
  // -------------------------------------------------------------------------
  app.get("/ai/chat/sessions/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) return reply.code(404).send({ error: "对话不存在" });

    const [rows, resume, full] = await Promise.all([
      prisma.aiChatMessage.findMany({
        where: { sessionId: id },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.resume.findFirst({ where: { id: session.resumeId, userId: request.userId } }),
      prisma.aiChatSession.findUnique({ where: { id }, include: SESSION_WITH_LAST_MESSAGE }),
    ]);

    return {
      session: sessionToMeta(full ?? session),
      messages: rows.reverse().map(messageToRecord),
      tasks: buildAuditTasks(resume?.analysis),
    };
  });

  // -------------------------------------------------------------------------
  // 4. 历史消息分页（游标为消息 id）
  // -------------------------------------------------------------------------
  app.get("/ai/chat/sessions/:id/messages", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const { before, limit } = request.query as { before?: string; limit?: string };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) return reply.code(404).send({ error: "对话不存在" });

    const take = Math.min(Math.max(Number(limit) || 30, 1), 100);
    let beforeDate: Date | undefined;
    if (before) {
      const anchor = await prisma.aiChatMessage.findUnique({ where: { id: before } });
      if (anchor?.sessionId === id) beforeDate = anchor.createdAt;
    }

    const rows = await prisma.aiChatMessage.findMany({
      where: { sessionId: id, ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
    });
    return { messages: rows.reverse().map(messageToRecord) };
  });

  // -------------------------------------------------------------------------
  // 5. 更新会话（标题 / 焦点 / JD / 归档）
  // -------------------------------------------------------------------------
  app.patch("/ai/chat/sessions/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      title?: string;
      focus?: string[];
      jd?: string | null;
      archived?: boolean;
    };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) return reply.code(404).send({ error: "对话不存在" });

    const data: Record<string, unknown> = {};
    if (typeof body.title === "string" && body.title.trim()) data.title = body.title.trim().slice(0, 60);
    if (Array.isArray(body.focus)) {
      const focus = body.focus.filter((f) => typeof f === "string" && f);
      data.focus = focus.length ? JSON.stringify(focus) : null;
    }
    if (body.jd !== undefined) data.jd = typeof body.jd === "string" && body.jd.trim() ? body.jd.trim() : null;
    if (typeof body.archived === "boolean") data.archived = body.archived;

    const updated = await prisma.aiChatSession.update({
      where: { id },
      data,
      include: SESSION_WITH_LAST_MESSAGE,
    });
    return { session: sessionToMeta(updated) };
  });

  // -------------------------------------------------------------------------
  // 6. 删除会话（消息靠外键级联）
  // -------------------------------------------------------------------------
  app.delete("/ai/chat/sessions/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) return reply.code(404).send({ error: "对话不存在" });
    await prisma.aiChatSession.delete({ where: { id } });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // 7. 发消息（SSE 流式）
  // -------------------------------------------------------------------------
  app.post("/ai/chat/sessions/:id/messages", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: string };
    const userText = (body.content ?? "").trim();
    if (!userText) return reply.code(400).send({ error: "消息内容不能为空" });

    const session = await prisma.aiChatSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.userId) return reply.code(404).send({ error: "对话不存在" });

    const resume = await prisma.resume.findFirst({ where: { id: session.resumeId, userId: request.userId } });
    if (!resume) return reply.code(404).send({ error: "简历不存在" });

    if (!isLLMAvailable()) return reply.code(400).send({ error: "未配置 AI 模型，无法对话" });

    const content = resume.content as unknown as ResumeContent;
    const focus = parseFocus(session.focus);
    const tasks = buildAuditTasks(resume.analysis);

    // 历史消息（不含本条）
    const historyRows = await prisma.aiChatMessage.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
    });

    // 用户最近说过的话（仅 user 角色，含本条）：事实核验与时间抽取都只认用户自己的话——
    // AI 回复里天然带大量日期，混进来会让「哪段日期属于本条经历」的判断失真。
    const userConvoText = [
      ...historyRows
        .slice(-HISTORY_MAX_COUNT)
        .filter((r) => r.role === "user")
        .map((r) => r.content),
      userText,
    ].join("\n");

    // 先落库用户消息：即使 LLM 失败，用户说的话也不丢
    await prisma.aiChatMessage.create({ data: { sessionId: id, role: "user", content: userText } });

    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache");
    raw.setHeader("Connection", "keep-alive");
    const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    let reasoningTxt = "";
    try {
      const budget = contextCharBudget();
      const messages: ChatMessage[] = [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        ...trimHistory(historyRows, budget),
        {
          role: "user",
          content: buildChatUserContent({
            content,
            focus,
            tasks,
            jd: session.jd ?? null,
            userText,
            refs: extractRefs(userText, content),
          }),
        },
      ];

      const text = await chatStream(
        messages,
        { jsonSchema: CHAT_SCHEMA, temperature: 0.4, maxTokens: 262144 },
        (d) => {
          reasoningTxt += d;
          send("reasoning", { delta: d });
        },
        (d) => send("content", { delta: d })
      );

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

      const { edits, rejected } = validateEdits(parsed.edits, content, userText, userConvoText);
      const replyText = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
      const llmAsks: string[] = Array.isArray(parsed.asks)
        ? parsed.asks.filter((a: unknown): a is string => typeof a === "string" && !!a.trim()).slice(0, 4)
        : [];
      // 本地兜底追问：卡片里仍缺必填项的，一定问出来，不依赖模型自觉
      const missingAsks: string[] = [];
      for (const e of edits) {
        if (e.op !== "append" || e.section === "basic") continue;
        const miss = checkAppendRequired(e.section, (e.item ?? {}) as Record<string, unknown>).filter(
          (m) => !llmAsks.some((a) => a.includes(m))
        );
        if (miss.length > 0) {
          const who = [e.item?.company, e.item?.school, e.item?.name].find((x): x is string => typeof x === "string" && !!x);
          missingAsks.push(`这段${sectionLabel(e.section)}${who ? `（${who}）` : ""}还缺：${miss.join("、")}，发我补上。`);
        }
      }
      const asks = [...llmAsks, ...missingAsks].slice(0, 5);

      const assistant = await prisma.aiChatMessage.create({
        data: {
          sessionId: id,
          role: "assistant",
          content: composeAssistantContent(replyText, asks),
          edits: edits as unknown as object,
          appliedIndexes: [] as unknown as object,
          reasoning: reasoningTxt || null,
        },
      });

      await prisma.aiChatSession.update({
        where: { id },
        data: {
          lastMessageAt: new Date(),
          // 首轮自动命名，便于会话列表辨识
          ...(session.title === "新对话" ? { title: userText.slice(0, 20) } : {}),
        },
      });

      await recordCall(prisma, request.userId, { reasoning: reasoningTxt, output: text }, { kind: "chat", resumeId: session.resumeId });

      send("result", { message: messageToRecord(assistant), edits, rejected });
      send("done", { ok: true });
    } catch (err) {
      console.error("[AI-CHAT] 对话失败:", err);
      send("error", { message: "对话失败，请重试" });
    }
    raw.end();
    return reply;
  });

  // -------------------------------------------------------------------------
  // 8. 标记某条建议卡片是否已应用
  // -------------------------------------------------------------------------
  app.post("/ai/chat/messages/:id/edits/:index/applied", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id, index } = request.params as { id: string; index: string };
    const body = (request.body ?? {}) as { applied?: boolean };
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) return reply.code(400).send({ error: "index 不合法" });

    const msg = await prisma.aiChatMessage.findUnique({ where: { id }, include: { session: true } });
    if (!msg || msg.session.userId !== request.userId) return reply.code(404).send({ error: "消息不存在" });

    const current = Array.isArray(msg.appliedIndexes) ? (msg.appliedIndexes as number[]) : [];
    const applied = body.applied !== false;
    const next = applied
      ? Array.from(new Set([...current, idx])).sort((a, b) => a - b)
      : current.filter((i) => i !== idx);

    const updated = await prisma.aiChatMessage.update({
      where: { id },
      data: { appliedIndexes: next as unknown as object },
    });
    return { ok: true, message: messageToRecord(updated) };
  });

  // -------------------------------------------------------------------------
  // 9. 权威校验 edits（卡片表单补空后 / 批量应用前调用）
  // -------------------------------------------------------------------------
  app.post("/ai/chat/validate-edits", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const body = (request.body ?? {}) as { resumeId?: string; edits?: unknown; userText?: string };
    if (!body.resumeId) return reply.code(400).send({ error: "resumeId 必填" });
    const resume = await requireResume(reply, body.resumeId, request.userId);
    if (!resume) return reply;

    const content = resume.content as unknown as ResumeContent;
    const { edits, rejected } = validateEdits(body.edits, content, body.userText ?? "");
    // 补充 append 必填项提示，供卡片表单使用
    const missing = edits.map((e) =>
      e.op === "append" && e.section !== "basic"
        ? checkAppendRequired(e.section as EditSection, e.item ?? {})
        : []
    );
    return { edits, rejected, missing };
  });

  // -------------------------------------------------------------------------
  // 10. 修订账本列表
  // -------------------------------------------------------------------------
  app.get("/ai/revisions", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { resumeId, limit, before } = request.query as { resumeId?: string; limit?: string; before?: string };
    if (!resumeId) return reply.code(400).send({ error: "resumeId 必填" });
    const resume = await requireResume(reply, resumeId, request.userId);
    if (!resume) return reply;

    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    let beforeDate: Date | undefined;
    if (before) {
      const anchor = await prisma.aiRevision.findUnique({ where: { id: before } });
      if (anchor?.resumeId === resumeId) beforeDate = anchor.createdAt;
    }

    const rows = await prisma.aiRevision.findMany({
      where: { resumeId, userId: request.userId, ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
    });
    return {
      revisions: rows.map((r) => ({
        ...r,
        revertedAt: r.revertedAt ? r.revertedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      // 只允许撤销最新一条未撤销的记录，避免前后依赖错乱
      revertibleId: rows.find((r) => !r.revertedAt)?.id ?? null,
    };
  });

  // -------------------------------------------------------------------------
  // 11. 记一笔修订（前端保存成功后调用）
  // -------------------------------------------------------------------------
  app.post("/ai/revisions", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const body = (request.body ?? {}) as {
      resumeId?: string;
      source?: string;
      op?: string;
      section?: string;
      field?: string;
      label?: string;
      beforeValue?: string | null;
      afterValue?: string | null;
      itemId?: string | null;
      sessionId?: string | null;
      messageId?: string | null;
    };
    if (!body.resumeId) return reply.code(400).send({ error: "resumeId 必填" });
    if (body.op !== "set" && body.op !== "append") return reply.code(400).send({ error: "op 不合法" });
    if (!body.section || !(body.section in SETTABLE_FIELDS)) return reply.code(400).send({ error: "section 不合法" });
    const resume = await requireResume(reply, body.resumeId, request.userId);
    if (!resume) return reply;

    const field = body.field || `${body.section}`;
    const revision = await prisma.aiRevision.create({
      data: {
        resumeId: body.resumeId,
        userId: request.userId,
        source: body.source === "analysis" ? "analysis" : "chat",
        op: body.op,
        section: body.section,
        field,
        label: body.label?.trim() || buildFieldLabel(field),
        beforeValue: body.beforeValue ?? null,
        afterValue: body.afterValue ?? null,
        itemId: body.itemId ?? null,
        sessionId: body.sessionId ?? null,
        messageId: body.messageId ?? null,
      },
    });
    return {
      revision: {
        ...revision,
        revertedAt: revision.revertedAt ? revision.revertedAt.toISOString() : null,
        createdAt: revision.createdAt.toISOString(),
      },
    };
  });

  // -------------------------------------------------------------------------
  // 12. 标记已撤销（简历回写由前端完成，服务端只当账本）
  // -------------------------------------------------------------------------
  app.patch("/ai/revisions/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { reverted?: boolean };
    const row = await prisma.aiRevision.findUnique({ where: { id } });
    if (!row || row.userId !== request.userId) return reply.code(404).send({ error: "记录不存在" });

    const updated = await prisma.aiRevision.update({
      where: { id },
      data: { revertedAt: body.reverted === false ? null : new Date() },
    });
    return {
      revision: {
        ...updated,
        revertedAt: updated.revertedAt ? updated.revertedAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
      },
    };
  });
}