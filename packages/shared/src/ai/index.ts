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

export type SessionMode = "chat" | "interview";

/**
 * 面试会话（列表用元信息）。
 * 刻意与 ChatSessionMeta 保持结构兼容，好让面试面板直接复用 ChatSessionPicker。
 */
export type InterviewSessionMeta = ChatSessionMeta & { targetRole: string | null };

export interface ChatMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  edits: ResumeEdit[] | null;
  appliedIndexes: number[];
  reasoning: string | null;
  meta?: InterviewTurnMeta | null; // 仅 mode=interview 会话的面试回合元数据
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 模拟面试
// 考察维度只有两个：真实性核验（追细节看是否真做过）与技术深度（看是否真懂）。
// ---------------------------------------------------------------------------

export type InterviewDimension = "authenticity" | "depth";
export type InterviewVerdict = "pass" | "weak" | "fail";

/** 面试的一个回合：assistant 消息带完整 meta，user 消息只带 questionId 便于串链 */
export interface InterviewTurnMeta {
  dimension: InterviewDimension; // 本轮考察维度
  probeDepth: number; // 0 开题 / 1 追问 / 2 深挖 / 3 收网
  questionId: string; // 同一道题跨轮不变，追问链靠它串联
  target?: string; // 考察的简历字段路径，如 "works[0]"
  targetLabel?: string; // 中文可读定位，如「工作经历 · 第1条」
  verdict?: InterviewVerdict; // 仅 authenticity 维度：回答与简历是否对得上
  score?: number; // 本题 0-100
  /**
   * 判定依据，由 quotes + reasons 配对组成（两者等长，下标一一对应）：
   * quotes 是**用户原话**（必须逐字引用，不许改写），reasons 说明这条原话为什么支撑当前判定。
   * 分开存而不是合成一句话，是为了让用户能拿原话去核对判定，而不是只能读模型的评价。
   */
  quotes?: string[];
  reasons?: string[];
  gap?: string; // 没答出来的点，直接驱动下一轮追问
  answered?: string; // 对用户本轮回答的要点概括（≤200 字）
  isClosing?: boolean; // 本条为「本题收尾」：不再有新题，question 为空
  isPlan?: boolean; // 会话首条：面试计划（含第一题）
  isReport?: boolean; // 面试收尾：总结报告
  questionCount?: number; // isPlan：计划题数；isReport：实际题数
  covered?: string[]; // 覆盖地图（全量快照）
}

// 用户对面试节奏的控制动作
export type InterviewAction = "answer" | "next" | "finish";

/** 面试总结报告（由所有 assistant meta 汇总，不额外调模型） */
export interface InterviewReport {
  sessionId: string;
  questionCount: number; // 出过的题总数（含跳过的）
  answeredCount: number; // 真正作答过的题数（均分只按这些算）
  avgScore: number; // 已答题目的均分
  authenticity: DimensionScore; // 真实性核验维度均分
  depth: DimensionScore; // 技术深度维度均分
  planTotal: number; // 计划题数（来自 isPlan 消息）
  finished: boolean; // 是否已收尾
  questions: InterviewQuestionSummary[];
}

export interface DimensionScore {
  score: number; // 0-100，无样本时为 0
  samples: number; // 该维度的评分样本数
  weakest: string | null; // 最弱的一题的问题摘要
}

export interface InterviewQuestionSummary {
  questionId: string;
  dimension: InterviewDimension;
  target?: string;
  targetLabel?: string;
  question: string; // 该题的开题问题
  probeDepth: number; // 实际追问到第几层
  verdict?: InterviewVerdict;
  score?: number; // 最终分（取最后一次判定）
  /**
   * 逐轮分数轨迹，按轮次升序。
   * 用户要能看到「60 → 75 → 85」这样的演进，而不是只拿到一个最终数字——
   * 分数在追问过程中是不断修正的，藏起来就看不出自己哪一轮开始慌了。
   */
  rounds?: InterviewRoundScore[];
  quotes?: string[];
  reasons?: string[];
  gap?: string;
  /** 用户从未作答（点「换一题」跳过）。这类题不参与均分，也不该显示成"没得分" */
  skipped?: boolean;
}

export interface InterviewRoundScore {
  depth: number; // 该轮的追问深度
  score?: number; // 该轮打分（模型偶尔会漏，此时只记深度）
  verdict?: InterviewVerdict;
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