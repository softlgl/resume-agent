// 简历数据结构定义（前后端共用）

export interface BasicInfo {
  name: string;
  title: string; // 求职意向 / 头衔
  phone: string;
  email: string;
  location: string;
  website: string;
  summary: string; // 个人简介
  avatar: string; // 头像 URL（可选）
  birthday: string; // 出生年月，格式 YYYY-MM
  gender: string; // 性别
  currentStatus: string; // 当前状态：在职 / 离职 / 应届 等
  expectedSalary: string; // 期望薪资
  workYears: string; // 工作年限
}

// 根据出生年月（YYYY-MM）计算年龄；无法解析时返回空串
export function calcAge(birthday: string): string {
  if (!birthday) return "";
  const m = /^(\d{4})-(\d{1,2})/.exec(birthday.trim());
  if (!m) return "";
  const by = Number(m[1]);
  const bm = Number(m[2]);
  const now = new Date();
  let age = now.getFullYear() - by;
  if (now.getMonth() + 1 < bm) age -= 1;
  return age > 0 && age < 120 ? String(age) : "";
}

export interface WorkExp {
  id: string;
  company: string;
  role: string;
  start: string;
  end: string;
  current: boolean; // 至今
  description: string; // 支持换行
}

export interface EduExp {
  id: string;
  school: string;
  major: string;
  degree: string;
  start: string;
  end: string;
  description: string;
}

export interface ProjectExp {
  id: string;
  name: string;
  company: string; // 所属公司（可引用工作经历的公司，也可为空）
  role: string;
  start: string;
  end: string;
  link: string;
  description: string;
}

export interface SkillGroup {
  id: string;
  category: string; // 分类，如 前端 / 后端 / 语言
  items: string; // 逗号或换行分隔的技能
}

export interface ResumeContent {
  basic: BasicInfo;
  works: WorkExp[];
  educations: EduExp[];
  projects: ProjectExp[];
  skills: SkillGroup[];
}

// 后端存储结构：简历记录
export interface ResumeRecord {
  id: string;
  userId: string;
  title: string;
  templateId: string;
  content: ResumeContent;
  createdAt: string;
  updatedAt: string;
}

// 创建/更新简历时的请求体（content 为简历数据）
export interface SaveResumeInput {
  title: string;
  templateId: string;
  content: ResumeContent;
}

// ---------------------------------------------------------------------------
// AI 对话与「建议 → 应用」闭环相关类型
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

export function emptyResumeContent(): ResumeContent {
  return {
    basic: {
      name: "",
      title: "",
      phone: "",
      email: "",
      location: "",
      website: "",
      summary: "",
      avatar: "",
      birthday: "",
      gender: "",
      currentStatus: "",
      expectedSalary: "",
      workYears: "",
    },
    works: [],
    educations: [],
    projects: [],
    skills: [],
  };
}
