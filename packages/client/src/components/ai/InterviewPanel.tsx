// 模拟面试面板
//
// 消息按 questionId 分组渲染成「题卡片」，而不是普通聊天气泡——面试的本质是一道题
// 连着若干层追问，逐层加压，混在一条时间线里看不出层级。判定（verdict/score/evidence）
// 也必须显式展示：这功能唯一的价值就是给出可追问的依据，藏起来等于白做。
//
// 回写简历走的是和 ChatPanel 完全相同的一套：edits 卡片 → EditCard → validateEdits →
// AiRevision 账本，且必须用户点「应用」才落库（面试是用户主动表达，AI 不替他确认事实）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Flag,
  Loader2,
  MapPin,
  Mic,
  Send,
  Square,
  Target,
  XCircle,
} from "lucide-react";
import { api } from "../../api/client";
import EditCard, { type ApplyResult } from "./EditCard";
import ChatSessionPicker from "./ChatSessionPicker";
import { MarkdownLite } from "../../utils/markdownLite";
import { fieldToLabel } from "../../utils/fieldLabel";
import type {
  AiRevisionRecord,
  ChatMessageRecord,
  InterviewAction,
  InterviewReport,
  InterviewSessionMeta,
  InterviewTurnMeta,
  ResumeEdit,
} from "@resume-agent/shared";

interface Props {
  open: boolean;
  resumeId: string | null;
  onApplyEdit: (edit: ResumeEdit) => Promise<ApplyResult>;
  onRevertRevision: (r: AiRevisionRecord) => Promise<boolean>;
  onRefreshRevisions: () => void;
  onGoto: (field: string) => void;
}

const DIMENSION_STYLE: Record<string, { label: string; chip: string }> = {
  authenticity: { label: "真实性核验", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  depth: { label: "技术深度", chip: "bg-indigo-50 text-indigo-700 border-indigo-200" },
};

const VERDICT_STYLE: Record<string, { label: string; chip: string }> = {
  pass: { label: "对得上", chip: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  weak: { label: "偏笼统", chip: "bg-amber-50 text-amber-700 border-amber-200" },
  fail: { label: "有矛盾", chip: "bg-red-50 text-red-700 border-red-200" },
};

const DIM_LABEL: Record<string, string> = {
  authenticity: "真实性核验",
  depth: "技术深度",
};

function dimStyle(d?: string) {
  return (d && DIMENSION_STYLE[d]) || { label: "面试", chip: "bg-slate-50 text-slate-600 border-slate-200" };
}
function verdictStyle(v?: string) {
  return (v && VERDICT_STYLE[v]) || null;
}

/** 一道题 = 一个 questionId 分组；判定取该组最后一次 assistant 的 meta */
interface QGroup {
  questionId: string;
  rows: ChatMessageRecord[];
  first: InterviewTurnMeta | null; // 维度 / 考察条目
  last: InterviewTurnMeta | null; // 判定 / 分数 / 缺口
  basis: InterviewTurnMeta | null; // 最后一次带原话引用的 meta（可能不是 last）
  /** 逐轮判定，按轮次升序。score 可能缺（模型没给），缺的那轮也要留着——否则「没打分」就看不见了 */
  verdicts: { depth: number; score?: number; verdict?: string; msgId: string }[];
  depth: number; // 实际追问到的层数
  closed: boolean;
  /** 用户从未作答（点「换一题」跳过）。这类题不该显示成"没得分" */
  skipped: boolean;
}

function groupQuestions(messages: ChatMessageRecord[]): {
  groups: QGroup[];
  plan: InterviewTurnMeta | null;
  reportMsg: ChatMessageRecord | null;
} {
  const groups: QGroup[] = [];
  const planTurns: InterviewTurnMeta[] = [];
  let reportMsg: ChatMessageRecord | null = null;

  for (const m of messages) {
    const meta = m.meta ?? null;
    if (meta?.isReport) {
      reportMsg = m;
      continue;
    }
    if (!meta?.questionId) continue;
    if (meta.isPlan) planTurns.push(meta);

    const g = groups[groups.length - 1];
    if (g && g.questionId === meta.questionId) {
      g.rows.push(m);
      if (m.role === "assistant") {
        if (meta.probeDepth > g.depth) g.depth = meta.probeDepth;
        if (typeof meta.isClosing === "boolean") g.closed = meta.isClosing;
        if (meta.verdict || typeof meta.score === "number" || meta.quotes?.length) g.last = meta;
        else if (!g.last) g.last = meta;
        // 依据要单独记：模型在收尾轮常常「有分数但不再引用原话」，
        // 若只跟着 g.last 走，判定区就会变成"有分没依据"（与后端 aggregateReport 同一个坑）
        if (meta.quotes?.length) g.basis = meta;
        // 每轮判定都留档，别被下一轮覆盖掉。
        // 只要这一轮带了判定信息（分数/结论/依据）就收进来——score 缺失也保留，
        // 轨迹里显示「未评分」，好过静默消失让人以为功能没做。
        if (typeof meta.score === "number" || meta.verdict || meta.quotes?.length) {
          g.verdicts.push({
            depth: meta.probeDepth ?? 0,
            ...(typeof meta.score === "number" ? { score: meta.score } : {}),
            verdict: meta.verdict,
            msgId: m.id,
          });
        }
      }
    } else {
      groups.push({
        questionId: meta.questionId,
        rows: [m],
        first: meta,
        last: meta,
        basis: meta.quotes?.length ? meta : null,
        verdicts: [],
        depth: meta.probeDepth ?? 0,
        closed: meta.isClosing === true,
        skipped: false,
      });
    }
  }
  for (const g of groups) {
    g.verdicts.sort((a, b) => a.depth - b.depth);
    // 整组跑完再定 skipped：判断依据是「有没有任何 user 回答」，与 meta 无关
    g.skipped = !g.rows.some((m) => m.role === "user");
  }
  return {
    groups,
    plan: planTurns[0] ?? null,
    reportMsg,
  };
}

/** 一轮 = 1 条面试官消息 + 其后用户的那条回答（追问链就是这样一问一答滚下来的） */
interface QTurn {
  key: string;
  assistant: ChatMessageRecord;
  answer?: ChatMessageRecord;
  depth: number;
  isLast: boolean;
}

/** 把题内消息按「一问一答」切轮次，保持时间顺序（之前按 role 分组渲染会打乱顺序） */
function toTurns(rows: ChatMessageRecord[]): QTurn[] {
  const turns: QTurn[] = [];
  let pending: ChatMessageRecord | null = null;
  for (const m of rows) {
    if (m.role === "assistant") {
      pending = m;
      turns.push({
        key: m.id,
        assistant: m,
        depth: m.meta?.probeDepth ?? 0,
        isLast: false,
      });
    } else if (pending) {
      turns[turns.length - 1].answer = m;
      pending = null;
    }
  }
  if (turns.length) turns[turns.length - 1].isLast = true;
  return turns;
}

function ScoreBar({ label, score, samples }: { label: string; score: number; samples: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-slate-500 w-16 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${score >= 80 ? "bg-emerald-500" : score >= 60 ? "bg-amber-500" : "bg-red-400"}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-[11px] text-slate-600 tabular-nums w-12 text-right">
        {samples > 0 ? `${score} 分` : "—"}
      </span>
    </div>
  );
}

export default function InterviewPanel({
  open,
  resumeId,
  onApplyEdit,
  onRevertRevision,
  onRefreshRevisions,
  onGoto,
}: Props) {
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<InterviewSessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [targetRole, setTargetRole] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [revisions, setRevisions] = useState<AiRevisionRecord[]>([]);
  const [report, setReport] = useState<InterviewReport | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleDraft, setRoleDraft] = useState("");
  const [countDraft, setCountDraft] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initRef = useRef<string | null>(null);

  const { groups, plan, reportMsg } = useMemo(() => groupQuestions(messages), [messages]);
  const finished = !!reportMsg;
  const currentGroup = finished ? null : groups[groups.length - 1] ?? null;
  const covered = plan?.covered ?? groups[groups.length - 1]?.last?.covered ?? [];
  // 计划题数达成：服务端不再开新题，等用户决定继续深挖还是收尾。
  // 兜底条件必须要求"最后一题已收尾"——只看 groups.length 会把"刚自动开出的最后一题"误判成已完成。
  const planTotal = plan?.questionCount ?? 0;
  const [planReached, setPlanReached] = useState<{ planTotal: number; askedCount: number } | null>(null);
  const planDone =
    !finished && (planReached != null || (planTotal > 0 && groups.length >= planTotal && currentGroup?.closed === true));

  useEffect(() => {
    if (!open) return;
    api.aiHealth().then((r) => setLlmAvailable(r.llmAvailable)).catch(() => {});
  }, [open]);

  const loadRevisions = useCallback(async () => {
    if (!resumeId) return;
    try {
      const r = await api.listRevisions(resumeId);
      setRevisions(r.revisions);
    } catch {
      /* 账本拉取失败不阻塞面试 */
    }
  }, [resumeId]);

  const openSession = useCallback(async (id: string) => {
    const res = await api.interviewGetSession(id);
    setSessionId(id);
    setTargetRole(res.session.targetRole);
    setMessages(res.messages);
    setInput("");
    // 会话可能已经结束过（刷新页面 / 换面试记录），把报告一并拉出来
    api
      .interviewReport(id)
      .then((r) => setReport(r.report.questionCount > 0 ? r.report : null))
      .catch(() => {});
  }, []);

  const createSession = useCallback(
    async (role?: string, count?: number) => {
      if (!resumeId) return;
      setError(null);
      setStreaming(true);
      setStreamText("");
      setReasoning("");
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const res = await api.interviewCreateSession(
          { resumeId, targetRole: role?.trim() || undefined, questionCount: count },
          (d) => setReasoning((p) => p + d),
          (d) => setStreamText((p) => p + d),
          ac.signal
        );
        setSessions((prev) => [
          {
            id: res.sessionId,
            resumeId,
            title: `模拟面试${res.targetRole ? ` · ${res.targetRole}` : ""}`,
            focus: [],
            jd: null,
            targetRole: res.targetRole,
            messageCount: 1,
            lastMessageAt: new Date().toISOString(),
          },
          ...prev,
        ]);
        setSessionId(res.sessionId);
        setTargetRole(res.targetRole);
        setMessages([res.message]);
        setReport(null);
      } catch (e: any) {
        if (e?.name === "AbortError") setError("已停止生成");
        else setError(e?.message || "创建面试失败");
      } finally {
        setStreaming(false);
        setStreamText("");
        setReasoning("");
        abortRef.current = null;
      }
    },
    [resumeId]
  );

  // 首次打开 → 拉面试会话列表；一场都没有就问用户岗位后开场
  useEffect(() => {
    if (!open || !resumeId) return;
    if (initRef.current === resumeId) return;
    initRef.current = resumeId;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await api.interviewListSessions(resumeId);
        setSessions(res.sessions);
        if (res.sessions.length > 0) {
          await openSession(res.sessions[0].id);
        } else {
          setRoleOpen(true);
        }
      } catch (e: any) {
        setError(e?.message || "加载面试记录失败");
      } finally {
        setBusy(false);
      }
    })();
  }, [open, resumeId, openSession]);

  useEffect(() => {
    if (sessionId) loadRevisions();
  }, [sessionId, loadRevisions]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, streaming]);

  const send = async (action: InterviewAction, text?: string) => {
    const value = (text ?? input).trim();
    if (!sessionId || streaming) return;
    if (action === "answer" && !value) return;
    // 用户主动「换一题」= 明确要继续深挖，清掉计划已达成的提示
    if (action === "next") setPlanReached(null);
    setInput("");
    setError(null);
    setStreamText("");
    setReasoning("");
    setStreaming(true);

    // 用户回答先乐观上屏。
    // meta.questionId 必须带上：groupQuestions 会跳过没有 questionId 的消息，
    // 少了它这条回答就进不了题组，会被误判成「已跳过」。
    if (action === "answer") {
      const qid = currentGroup?.questionId;
      const optimistic: ChatMessageRecord = {
        id: `local-${Date.now()}`,
        sessionId,
        role: "user",
        content: value,
        edits: null,
        appliedIndexes: [],
        reasoning: null,
        meta: qid ? { dimension: "authenticity", probeDepth: 0, questionId: qid } : null,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
    }

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await api.interviewSendStream(
        sessionId,
        { action, ...(action === "answer" ? { content: value } : {}) },
        (d) => setReasoning((p) => p + d),
        (d) => setStreamText((p) => p + d),
        ac.signal
      );
      setMessages((prev) => [
        // 乐观副本一律丢弃，改用服务端回传的真实消息（带 id / createdAt / meta）
        ...prev.filter((m) => !m.id.startsWith("local-")),
        ...(res.userMessage ? [res.userMessage] : []),
        res.message,
        ...(res.message2 ? [res.message2] : []),
      ]);
      setStreamText("");
      setReasoning("");
      setPlanReached(res.planReached ?? null);
      if (res.report) setReport(res.report);
    } catch (e: any) {
      if (e?.name === "AbortError") setError("已停止生成");
      else setError(e?.message || "发送失败");
      setStreamText("");
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  /** 该 edit 是否还有未撤销的账本记录可撤销（口径与 ChatPanel / RevisionHistory 一致） */
  const findRevertible = (edit: ResumeEdit) =>
    revisions.find(
      (r) =>
        !r.revertedAt &&
        ((edit.op === "append" && edit.itemId && r.itemId === edit.itemId) ||
          (edit.op === "set" && edit.field && r.field === edit.field))
    );

  /** 面试产出的 edits 手动应用：走与对话完全相同的 applied 标记 + 账本刷新 */
  const applyEdit = async (msg: ChatMessageRecord, index: number, edit: ResumeEdit): Promise<ApplyResult> => {
    const res = await onApplyEdit(edit);
    if (!res.ok) return res;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msg.id
          ? { ...m, appliedIndexes: Array.from(new Set([...m.appliedIndexes, index])).sort((a, b) => a - b) }
          : m
      )
    );
    api.chatMarkEditApplied(msg.id, index, true).catch(() => {});
    onRefreshRevisions();
    await loadRevisions();
    return res;
  };

  const revertEdit = async (edit: ResumeEdit, msg: ChatMessageRecord, index: number) => {
    setError(null);
    const target = revisions.find(
      (r) =>
        !r.revertedAt &&
        ((edit.op === "append" && edit.itemId && r.itemId === edit.itemId) ||
          (edit.op === "set" && edit.field && r.field === edit.field))
    );
    if (!target) {
      setError("未找到对应的修改记录（可能已撤销），请到「修改历史」查看");
      return;
    }
    const ok = await onRevertRevision(target);
    if (!ok) return;
    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, appliedIndexes: m.appliedIndexes.filter((i) => i !== index) } : m))
    );
    api.chatMarkEditApplied(msg.id, index, false).catch(() => {});
    onRefreshRevisions();
    await loadRevisions();
  };

  const startWithRole = () => {
    const role = roleDraft.trim();
    const n = Number(countDraft);
    setRoleOpen(false);
    setRoleDraft("");
    setCountDraft("");
    createSession(role || undefined, countDraft.trim() && n > 0 ? n : undefined);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ---- 会话栏 ---- */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-slate-100">
        <ChatSessionPicker
          sessions={sessions}
          currentId={sessionId}
          disabled={!resumeId || busy || streaming}
          onSelect={openSession}
          onCreate={() => setRoleOpen(true)}
          onRename={async (id, title) => {
            await api.interviewRenameSession(id, title).catch(() => {});
            setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
          }}
          onDelete={async (id) => {
            await api.interviewDeleteSession(id).catch(() => {});
            const rest = sessions.filter((s) => s.id !== id);
            setSessions(rest);
            if (sessionId === id) {
              if (rest.length > 0) await openSession(rest[0].id);
              else {
                setSessionId(null);
                setMessages([]);
                setReport(null);
              }
            }
          }}
        />
        <button
          onClick={() => setRoleOpen(true)}
          disabled={!resumeId || busy || streaming}
          title="开始一场新面试"
          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-brand-600 hover:border-brand-300 transition disabled:opacity-40"
        >
          <Mic size={14} />
        </button>
        {targetRole && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-500 border border-slate-200 rounded px-1.5 py-[1px]">
            <Target size={11} /> {targetRole}
          </span>
        )}
      </div>

      {/* ---- 覆盖地图 ---- */}
      {(plan || groups.length > 0) && (
        <div className="shrink-0 px-4 py-2 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <span className="inline-flex items-center gap-0.5 text-slate-400">
              <MapPin size={11} /> 覆盖进度
            </span>
            <span className="text-slate-600 tabular-nums">
              {groups.length}
              {plan?.questionCount ? ` / ${plan.questionCount}` : ""} 题
              {groups.some((g) => g.skipped) && (
                <span className="text-slate-400">（跳过 {groups.filter((g) => g.skipped).length}）</span>
              )}
            </span>
            {covered.map((p) => (
              <button
                key={p}
                onClick={() => onGoto(p)}
                title="定位到编辑器"
                className="text-brand-700 bg-brand-50 border border-brand-200 rounded px-1.5 py-[1px] hover:bg-brand-100"
              >
                {fieldToLabel(p)}
              </button>
            ))}
            {finished && (
              <span className="ml-auto inline-flex items-center gap-1 text-emerald-700">
                <CheckCircle2 size={11} /> 已结束
              </span>
            )}
          </div>
        </div>
      )}

      {/* ---- 消息区 ---- */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {!resumeId && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>请先保存简历后再开始面试，AI 需要读取已保存的内容才能针对具体条目提问。</span>
          </div>
        )}
        {llmAvailable === false && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>未配置 AI 模型，无法进行模拟面试。点右上角齿轮配置 LLM 后即可使用。</span>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}>
              <XCircle size={13} />
            </button>
          </div>
        )}

        {/* 开场：还没会话 */}
        {!sessionId && !roleOpen && !busy && (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center">
            <ClipboardCheck size={22} className="mx-auto text-brand-500 mb-2" />
            <p className="text-sm text-slate-700 font-medium">开始一场模拟面试</p>
            <p className="text-xs text-slate-500 mt-1">
              面试官会读你的简历，从具体经历里长出问题，逐层追问。
              <br />
              只有「真实性核验」和「技术深度」两个维度，追问到第 3 层就会换题。
            </p>
            <button
              onClick={() => setRoleOpen(true)}
              className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700"
            >
              开始
            </button>
          </div>
        )}

        {/* 岗位 + 题数（开场前） */}
        {roleOpen && (
          <div className="rounded-xl border border-brand-200 bg-brand-50/40 px-4 py-3 space-y-2">
            <p className="text-xs text-slate-700 font-medium">面试岗位（可留空，默认取简历里的求职意向）</p>
            <input
              value={roleDraft}
              onChange={(e) => setRoleDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startWithRole()}
              placeholder="例：前端工程师 / Node.js 后端"
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
            />
            <p className="text-xs text-slate-700 font-medium pt-1">
              面试题数（可留空，由面试官按简历长度建议）
            </p>
            <input
              value={countDraft}
              onChange={(e) => setCountDraft(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && startWithRole()}
              inputMode="numeric"
              placeholder="例：5（上限 12）"
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
            />
            <div className="flex gap-2">
              <button
                onClick={startWithRole}
                disabled={streaming}
                className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                开始面试
              </button>
              {sessionId && (
                <button
                  onClick={() => {
                    setRoleOpen(false);
                    setRoleDraft("");
                    setCountDraft("");
                  }}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-white"
                >
                  取消
                </button>
              )}
            </div>
          </div>
        )}

        {/* 题目卡片 */}
        {groups.map((g, gi) => {
          const dim = dimStyle(g.first?.dimension);
          const verdict = verdictStyle(g.last?.verdict);
          // 跳过的题不算「进行中」——它已经被换题动作终止了
          const isCurrent = currentGroup?.questionId === g.questionId && !g.skipped;
          const turns = toTurns(g.rows);
          return (
            <div
              key={g.questionId}
              className={`rounded-xl border bg-white overflow-hidden ${
                isCurrent ? "border-brand-300 ring-1 ring-brand-100" : "border-slate-200"
              }`}
            >
              {/* 题头 */}
              <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-100 bg-slate-50/60">
                <span className="text-[11px] text-slate-500 font-medium">第 {gi + 1} 题</span>
                <span className={`text-[10px] border rounded px-1 py-[1px] ${dim.chip}`}>{dim.label}</span>
                {g.first?.targetLabel && (
                  <span className="text-[10px] text-slate-500 inline-flex items-center gap-0.5">
                    <MapPin size={9} />
                    {g.first.targetLabel}
                  </span>
                )}
                {/* 追问层级：按「你实际答了几轮」点亮，不直接信 meta.probeDepth（旧数据可能是脏的） */}
                <span className="ml-auto flex items-center gap-0.5" title={`已答 ${g.verdicts.length} 轮`}>
                  {[0, 1, 2, 3].map((lv) => (
                    <span
                      key={lv}
                      className={`w-1.5 h-1.5 rounded-full ${lv < g.verdicts.length ? "bg-brand-500" : "bg-slate-200"}`}
                    />
                  ))}
                </span>
                {g.skipped ? (
                  <span className="text-[10px] text-slate-400">已跳过</span>
                ) : g.closed ? (
                  <span className="text-[10px] text-slate-400">已收尾</span>
                ) : null}
                {isCurrent && <span className="text-[10px] text-brand-600">进行中</span>}
              </div>

              {/* 逐轮问答：开题与收尾常显，中间追问折起来（折起来的恰是信息密度最低的） */}
              <div className="px-3 py-2 space-y-2.5">
                {turns.map((t, ti) => {
                  const m = t.assistant;
                  const body = (
                    <>
                      <MarkdownLite text={m.content} />
                      {m.edits && m.edits.length > 0 && (
                        <div className="mt-2 space-y-2">
                          <p className="text-[11px] text-slate-500 inline-flex items-center gap-1">
                            <Flag size={10} /> 面试中补充的细节（你确认后才会写进简历）
                          </p>
                          {m.edits.map((e, i) => (
                            <EditCard
                              key={i}
                              edit={e}
                              applied={m.appliedIndexes.includes(i)}
                              disabled={!resumeId}
                              onApply={(edited) => applyEdit(m, i, edited)}
                              onRevert={findRevertible(e) ? () => revertEdit(e, m, i) : undefined}
                              onGoto={onGoto}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  );

                  // 折叠中间轮次：开题（第 0 层）与收尾（最后一轮）保持可见
                  if (!t.isLast && ti !== 0) {
                    return (
                      <details key={t.key} className="group">
                        <summary className="cursor-pointer list-none flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-600 select-none py-0.5">
                          <ChevronRight
                            size={12}
                            className="transition group-open:rotate-90 shrink-0"
                          />
                          <span>
                            第 {t.depth} 层追问
                            {t.answer ? ` · 你答了 ${t.answer.content.length} 字` : " · 未作答"}
                          </span>
                        </summary>
                        <div className="mt-1.5 pl-4 space-y-2 border-l-2 border-slate-100">
                          {body}
                          {t.answer && (
                            <div className="pl-2">
                              <p className="text-[10px] text-slate-400 mb-0.5">你的回答</p>
                              <p className="text-xs text-slate-700 whitespace-pre-wrap">{t.answer.content}</p>
                            </div>
                          )}
                        </div>
                      </details>
                    );
                  }

                  return (
                    <div key={t.key} className="space-y-2">
                      {body}
                      {t.answer && (
                        <div className="pl-3 border-l-2 border-slate-200">
                          <p className="text-[10px] text-slate-400 mb-0.5">你的回答</p>
                          <p className="text-xs text-slate-700 whitespace-pre-wrap">{t.answer.content}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 判定：结论醒目（徽章 + 分数），依据降权（浅灰引文 + 更浅的理由） */}
              {g.skipped ? (
                <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/40">
                  <p className="text-[11px] text-slate-400">已跳过（未作答，不计分）</p>
                </div>
              ) : (
                (verdict || typeof g.last?.score === "number" || g.basis?.quotes?.length || g.last?.gap) && (
                <div className="px-3 py-2 border-t border-slate-100 bg-slate-50/40 space-y-1.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {verdict && (
                      <span className={`text-[10px] border rounded px-1.5 py-[1px] ${verdict.chip}`}>
                        真实性：{verdict.label}
                      </span>
                    )}
                    {typeof g.last?.score === "number" ? (
                      <span className="text-[10px] text-slate-600 tabular-nums">本题 {g.last.score} 分</span>
                    ) : (
                      <span className="text-[10px] text-slate-400">未评分</span>
                    )}
                  </div>
                  {/* 分数轨迹：分数是随追问逐轮修正的，只给最终分会看不出你哪一轮开始慌了 */}
                  {g.verdicts.length > 1 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] text-slate-400">轨迹</span>
                      {g.verdicts.map((v, i) => (
                        <span key={`${v.msgId}-${i}`} className="flex items-center gap-1">
                          {i > 0 && <span className="text-slate-300">→</span>}
                          {typeof v.score === "number" ? (
                            <span
                              title={`第 ${i + 1} 轮作答${v.verdict ? ` · ${{ pass: "对得上", weak: "偏笼统", fail: "有矛盾" }[v.verdict] ?? ""}` : ""}`}
                              className={`text-[10px] tabular-nums px-1 py-[1px] rounded ${
                                v.score >= 80
                                  ? "bg-emerald-50 text-emerald-700"
                                  : v.score >= 60
                                    ? "bg-amber-50 text-amber-700"
                                    : "bg-red-50 text-red-700"
                              }`}
                            >
                              {i + 1}轮 {v.score}
                            </span>
                          ) : (
                            <span
                              title="模型这一轮没给出分数"
                              className="text-[10px] tabular-nums px-1 py-[1px] rounded bg-slate-50 text-slate-400 border border-dashed border-slate-200"
                            >
                              {i + 1}轮 未评分
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {g.basis?.quotes?.length ? (
                    <ul className="space-y-1">
                      {g.basis.quotes.map((q, i) => (
                        <li key={i} className="border-l-2 border-slate-200 pl-2">
                          <p className="text-[11px] text-slate-500 italic">「{q}」</p>
                          {g.basis?.reasons?.[i] && (
                            <p className="text-[10px] text-slate-400 mt-0.5">{g.basis.reasons[i]}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {g.last?.gap && (
                    <p className="text-[11px] text-amber-700">还没答上来：{g.last.gap}</p>
                  )}
                </div>
                )
              )}
            </div>
          );
        })}

        {/* 报告 */}
        {reportMsg && report && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/30 overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-emerald-100">
              <ClipboardCheck size={14} className="text-emerald-600" />
              <span className="text-xs font-medium text-slate-700">面试报告</span>
              <span className="ml-auto text-[11px] text-slate-500 tabular-nums">
                综合 {report.avgScore} 分
                <span className="text-slate-400">
                  {' '}
                  · 作答 {report.answeredCount}/{report.questionCount} 题
                </span>
              </span>
            </div>
            <div className="px-3 py-2.5 space-y-2">
              <ScoreBar label="真实性核验" score={report.authenticity.score} samples={report.authenticity.samples} />
              <ScoreBar label="技术深度" score={report.depth.score} samples={report.depth.samples} />
              {report.questions.filter((q) => q.quotes?.length).length > 0 && (
                <details className="group">
                  <summary className="cursor-pointer list-none flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 select-none">
                    <ChevronRight size={12} className="transition group-open:rotate-90" />
                    逐题依据（{report.questions.filter((q) => q.quotes?.length).length} 题有原话引用）
                  </summary>
                  <ul className="mt-1.5 space-y-2">
                    {report.questions
                      .filter((q) => q.quotes?.length)
                      .map((q, i) => (
                        <li key={i} className="border-l-2 border-slate-200 pl-2">
                          <p className="text-[11px] text-slate-600">
                            {DIM_LABEL[q.dimension] ?? "面试"} · {q.targetLabel ?? "未定位"}
                            {typeof q.score === "number" ? ` · ${q.score} 分` : ""}
                            {q.rounds && q.rounds.length > 1 && (
                              <span className="text-slate-400">
                                {" "}
                                （{q.rounds.map((r) => r.score ?? "—").join(" → ")}）
                              </span>
                            )}
                          </p>
                          {q.quotes!.map((quote, j) => (
                            <div key={j} className="mt-1">
                              <p className="text-[11px] text-slate-500 italic">「{quote}」</p>
                              {q.reasons?.[j] && <p className="text-[10px] text-slate-400">{q.reasons[j]}</p>}
                            </div>
                          ))}
                          {q.gap && <p className="text-[10px] text-amber-700 mt-0.5">缺口：{q.gap}</p>}
                        </li>
                      ))}
                  </ul>
                </details>
              )}
              <div className="pt-1 border-t border-emerald-100/70">
                <MarkdownLite text={reportMsg.content} />
              </div>
            </div>
          </div>
        )}

        {/* 流式输出 */}
        {streaming && (
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            {reasoning && (
              <details className="mb-2 text-[11px] text-slate-400">
                <summary className="cursor-pointer select-none">思考过程</summary>
                <p className="mt-1 whitespace-pre-wrap">{reasoning}</p>
              </details>
            )}
            {streamText ? (
              <div className="text-xs text-slate-600">
                <MarkdownLite text={streamText} />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Loader2 size={13} className="animate-spin" /> 面试官正在思考…
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- 输入区 ---- */}
      {sessionId && !finished && (
        <div className="shrink-0 border-t border-slate-100 px-4 py-2.5">
          {/* 计划题数达成：不再自动开新题，把决定权交回用户 */}
          {planDone && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
              <div className="flex-1">
                <p>
                  面试计划已完成（{planReached?.askedCount ?? groups.length} / {planReached?.planTotal ?? planTotal} 题）。
                  点「结束面试」生成报告，或点「换一题」继续深挖。
                </p>
              </div>
              <button
                onClick={() => send("finish")}
                disabled={streaming}
                className="shrink-0 text-[11px] px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                生成报告
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send("answer");
                }
              }}
              placeholder={
                currentGroup?.closed || !currentGroup
                  ? "按「换一题」让面试官问下一道"
                  : "按真实经历回答，越具体越能撑住追问（Enter 发送，Shift+Enter 换行）"
              }
              disabled={streaming}
              className="flex-1 rounded-lg border border-slate-200 px-2.5 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            />
            <div className="flex flex-col gap-1">
              <button
                onClick={() => send("answer")}
                disabled={streaming || !input.trim()}
                title="回答当前问题"
                className="p-2 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40"
              >
                <Send size={14} />
              </button>
              {streaming ? (
                <button
                  onClick={() => abortRef.current?.abort()}
                  title="停止"
                  className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  onClick={() => send("next")}
                  title="跳过这题，问下一题"
                  className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                >
                  <Target size={14} />
                </button>
              )}
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={() => send("finish")}
              disabled={streaming || groups.length === 0}
              className="text-[11px] inline-flex items-center gap-1 text-slate-500 hover:text-red-600 disabled:opacity-40"
            >
              <Flag size={11} /> 结束面试并生成报告
            </button>
            <span className="ml-auto text-[11px] text-slate-400">
              追问到第 3 层会自动换题 · 回写简历需你点「应用」
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
