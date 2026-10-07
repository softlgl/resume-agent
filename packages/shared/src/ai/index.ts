// ---------------------------------------------------------------------------
// AI 域共享类型：AI 分析、对话与「建议 → 应用」闭环
// 从 resume.ts 抽出集中于此；对外仍由 @resume-agent/shared 统一导出（导出名不变）。
// ---------------------------------------------------------------------------

export type EditSection = "basic" | "works" | "educations" | "projects" | "skills";
export type EditOp = "set" | "append";

// 一次可应用的修改（AI 产出，经服务端 validateEdits 校验后的规范化形态）
export interface ResumeEdit {
  op: EditOp;
  section: EditSection;
  field?: string; // op=set 时必有，如 "works[0].description"
  label: string; // 中文可读定位，如 "工作经历 · 第1条 · 描述"
  before?: string; // op=set：当前值（服务端从简历读出，非 AI 提供）
  after?: string; // op=set：改写后内容
  item?: Record<string, string | boolean>; // op=append：新条目骨架（事实字段已置空）
  itemId?: string; // op=append：服务端预生成的条目 id
  reason?: string; // 为什么这么改
  risks?: string[]; // 风险提示（可能引入了原文没有的信息 / 未在对话中出现的事实）
}

// 修改账本条目（append-only，撤销只写 revertedAt）
export interface AiRevisionRecord {
  id: string;
  resumeId: string;
  source: "chat" | "analysis";
  op: EditOp;
  section: string;
  field: string;
  label: string;
  beforeValue: string | null;
  afterValue: string | null;
  itemId: string | null;
  sessionId: string | null;
  messageId: string | null;
  revertedAt: string | null;
  createdAt: string;
}

// 新建一笔账本记录时的请求体
export interface CreateRevisionInput {
  resumeId: string;
  source: "chat" | "analysis";
  op: EditOp;
  section: string;
  field: string;
  label: string;
  beforeValue?: string | null;
  afterValue?: string | null;
  itemId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
}

// 对话会话（列表用元信息）
export interface ChatSessionMeta {
  id: string;
  resumeId: string;
  title: string;
  focus: string[];
  jd: string | null;
  messageCount: number;
  lastMessageAt: string;
  preview?: string; // 最后一条消息摘要
}

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  edits: ResumeEdit[] | null;
  appliedIndexes: number[];
  reasoning: string | null;
  createdAt: string;
}

// 体检待办（由 Resume.analysis 本地拼装，不调 LLM）
export interface AuditTask {
  id: string; // 稳定 key，如 "gap:TypeScript"
  kind: "issue" | "gap";
  severity: "error" | "warning" | "tip";
  title: string;
  field?: string;
  prompt: string; // 点「让 AI 处理」时预填进输入框的内容
}