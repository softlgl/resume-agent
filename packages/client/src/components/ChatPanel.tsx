import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AtSign,
  Brain,
  Check,
  CornerDownRight,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Target,
  X,
} from "lucide-react";
import { api } from "../api/client";
import EditCard, { type ApplyResult } from "./EditCard";
import ChatSessionPicker from "./ChatSessionPicker";
import { MarkdownLite } from "../utils/markdownLite";
import { fieldToLabel } from "../utils/fieldLabel";
import type {
  AiRevisionRecord,
  AuditTask,
  ChatMessageRecord,
  ChatSessionMeta,
  EditSection,
  ResumeEdit,
} from "@resume-agent/shared";

interface Props {
  open: boolean;
  content: any;
  resumeId: string | null;
  focus: string[];
  onFocusChange: (f: string[]) => void;
  presetPrompt?: string | null;
  onConsumePresetPrompt?: () => void;
  onApplyEdit: (edit: ResumeEdit) => Promise<ApplyResult>;
  onRevertRevision: (r: AiRevisionRecord) => Promise<boolean>;
  onRefreshRevisions: () => void;
  onGoto: (field: string) => void;
}

const SECTION_TITLES: [EditSection, string][] = [
  ["basic", "基本信息"],
  ["works", "工作经历"],
  ["educations", "教育经历"],
  ["projects", "项目经历"],
  ["skills", "技能"],
];

// 可被 @ 引用 / 设为焦点的字段路径（按当前简历动态生成）
function buildFieldOptions(content: any): { value: string; label: string }[] {
  const opts: { value: string; label: string }[] = [];
  if (!content) return opts;
  if (content.basic?.summary) opts.push({ value: "basic.summary", label: "基本信息 · 个人简介" });
  for (const [key, title] of SECTION_TITLES) {
    if (key === "basic") continue;
    const list = content[key];
    if (!Array.isArray(list)) continue;
    list.forEach((it: any, i: number) => {
      const name = it?.company || it?.school || it?.name || it?.category || "";
      opts.push({
        value: `${key}[${i}]`,
        label: `${title} · 第${i + 1}条${name ? ` · ${name}` : ""}`,
      });
    });
  }
  return opts;
}

const QUICK_ACTIONS = [
  "润色这段描述，让它更专业",
  "这段经历还缺什么信息？",
  "把成果改得更量化",
  "针对目标岗位 JD 优化",
  "帮我新增一段经历",
];

function severityDot(sev: AuditTask["severity"]) {
  if (sev === "error") return "bg-red-500";
  if (sev === "warning") return "bg-amber-500";
  return "bg-sky-500";
}

export default function ChatPanel({
  open,
  content,
  resumeId,
  focus,
  onFocusChange,
  presetPrompt,
  onConsumePresetPrompt,
  onApplyEdit,
  onRevertRevision,
  onRefreshRevisions,
  onGoto,
}: Props) {
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [tasks, setTasks] = useState<AuditTask[]>([]);
  const [revisions, setRevisions] = useState<AiRevisionRecord[]>([]);
  const [jd, setJd] = useState("");
  const [jdOpen, setJdOpen] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [picker, setPicker] = useState<null | "focus" | "at">(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const initRef = useRef<string | null>(null);

  const fieldOptions = useMemo(() => buildFieldOptions(content), [content]);

  // LLM 可用性：未配置时禁用输入
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
      /* 账本拉取失败不阻塞对话 */
    }
  }, [resumeId]);

  const openSession = useCallback(async (id: string) => {
    const res = await api.chatGetSession(id);
    setSessionId(id);
    setMessages(res.messages);
    setTasks(res.tasks);
    setJd(res.session.jd ?? "");
    setSessions((prev) => prev.map((s) => (s.id === id ? res.session : s)));
  }, []);

  const createSession = useCallback(
    async (withOpening: boolean) => {
      if (!resumeId) return;
      const res = await api.chatCreateSession({ resumeId, focus, withOpening });
      setSessions((prev) => [res.session, ...prev.filter((s) => s.id !== res.session.id)]);
      setSessionId(res.session.id);
      setMessages(res.messages);
      setTasks(res.tasks);
      setJd(res.session.jd ?? "");
    },
    [resumeId, focus]
  );

  // 首次打开 → 拉会话列表；没有历史就新建一个带开场消息的会话
  useEffect(() => {
    if (!open || !resumeId) return;
    if (initRef.current === resumeId) return;
    initRef.current = resumeId;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const res = await api.chatListSessions(resumeId);
        setSessions(res.sessions);
        if (res.sessions.length > 0) await openSession(res.sessions[0].id);
        else await createSession(true);
      } catch (e: any) {
        setError(e?.message || "加载对话失败");
      } finally {
        setBusy(false);
      }
    })();
  }, [open, resumeId, openSession, createSession]);

  useEffect(() => {
    if (sessionId) loadRevisions();
  }, [sessionId, loadRevisions]);

  // 卸载（关闭抽屉）时中止进行中的流
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // 自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamText, streaming]);

  // 「问问 AI」把预填内容送达
  useEffect(() => {
    if (presetPrompt && open) {
      setInput(presetPrompt);
      onConsumePresetPrompt?.();
    }
  }, [presetPrompt, open, onConsumePresetPrompt]);

  const send = async (text?: string) => {
    const value = (text ?? input).trim();
    if (!value || !sessionId || streaming) return;
    setInput("");
    setError(null);
    setStreamText("");
    setReasoning("");
    setStreaming(true);

    const optimistic: ChatMessageRecord = {
      id: `local-${Date.now()}`,
      sessionId,
      role: "user",
      content: value,
      edits: null,
      appliedIndexes: [],
      reasoning: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await api.chatSendStream(
        sessionId,
        value,
        (d) => setReasoning((p) => p + d),
        (d) => setStreamText((p) => p + d),
        ac.signal
      );
      setMessages((prev) => [...prev, res.message]);
      setStreamText("");
      setReasoning("");
      if (res.rejected?.length) {
        setError(`有 ${res.rejected.length} 条建议被安全校验拦下：${res.rejected.join("；")}`);
      }
      // 首轮自动命名 / 待办刷新
      api
        .chatGetSession(sessionId)
        .then((r) => {
          setSessions((prev) =>
            prev.some((s) => s.id === r.session.id)
              ? prev.map((s) => (s.id === r.session.id ? r.session : s))
              : [r.session, ...prev]
          );
          setTasks(r.tasks);
        })
        .catch(() => {});
    } catch (e: any) {
      if (e?.name === "AbortError") setError("已停止生成");
      else setError(e?.message || "发送失败");
      setStreamText("");
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const retry = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) send(lastUser.content);
  };

  const applyChatEdit = async (
    msg: ChatMessageRecord,
    index: number,
    edit: ResumeEdit
  ): Promise<ApplyResult> => {
    const res = await onApplyEdit(edit);
    if (!res.ok) return res;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msg.id
          ? {
              ...m,
              appliedIndexes: Array.from(new Set([...m.appliedIndexes, index])).sort((a, b) => a - b),
            }
          : m
      )
    );
    api.chatMarkEditApplied(msg.id, index, true).catch(() => {});
    if (edit.field) setTasks((prev) => prev.filter((t) => t.field !== edit.field));
    onRefreshRevisions();
    await loadRevisions();
    return res;
  };

  // 撤销：按 field / itemId 找到最新一条未撤销的账本记录
  const revertChatEdit = async (edit: ResumeEdit, msg: ChatMessageRecord, index: number) => {
    const target = revisions.find(
      (r) =>
        !r.revertedAt &&
        ((edit.op === "append" && edit.itemId && r.itemId === edit.itemId) ||
          (edit.op === "set" && edit.field && r.field === edit.field))
    );
    if (!target) {
      setError("未找到对应的修改记录（可能已撤销或已被更新的修改覆盖），请到「修改历史」查看");
      return;
    }
    const ok = await onRevertRevision(target);
    if (ok) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, appliedIndexes: m.appliedIndexes.filter((i) => i !== index) } : m
        )
      );
      api.chatMarkEditApplied(msg.id, index, false).catch(() => {});
      await loadRevisions();
    }
  };

  const renameSession = async (id: string, title: string) => {
    try {
      const res = await api.chatUpdateSession(id, { title });
      setSessions((prev) => prev.map((s) => (s.id === id ? res.session : s)));
    } catch (e: any) {
      setError(e?.message || "重命名失败");
    }
  };

  const deleteSession = async (id: string) => {
    if (!confirm("删除这个对话？对话记录与其中的建议卡片都会消失。")) return;
    try {
      await api.chatDeleteSession(id);
      const next = sessions.filter((s) => s.id !== id);
      setSessions(next);
      if (sessionId === id) {
        if (next.length > 0) await openSession(next[0].id);
        else await createSession(true);
      }
    } catch (e: any) {
      setError(e?.message || "删除失败");
    }
  };

  const applyFocus = async (next: string[]) => {
    onFocusChange(next);
    if (sessionId) {
      try {
        const res = await api.chatUpdateSession(sessionId, { focus: next });
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? res.session : s)));
      } catch {
        /* 焦点未落库不影响本次对话 */
      }
    }
  };

  const addFocus = (path: string) => {
    setPicker(null);
    if (!path || focus.includes(path)) return;
    applyFocus([...focus, path]);
  };

  const addRef = (path: string) => {
    setPicker(null);
    setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${path} `);
  };

  const saveJd = async () => {
    if (!sessionId) return;
    try {
      await api.chatUpdateSession(sessionId, { jd: jd.trim() || null });
    } catch {
      /* 忽略 */
    }
  };

  const disabledInput = llmAvailable === false || !resumeId || !sessionId || busy;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ---- 会话栏 ---- */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-slate-100">
        <ChatSessionPicker
          sessions={sessions}
          currentId={sessionId}
          disabled={!resumeId || busy}
          onSelect={openSession}
          onCreate={() => createSession(true)}
          onRename={renameSession}
          onDelete={deleteSession}
        />
        <button
          onClick={() => createSession(false)}
          disabled={!resumeId || busy}
          title="新建空白对话"
          className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-brand-600 hover:border-brand-300 transition disabled:opacity-40"
        >
          <MessageSquarePlus size={14} />
        </button>
      </div>

      {/* ---- 焦点栏 ---- */}
      <div className="shrink-0 px-4 py-2 border-b border-slate-100">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] text-slate-400 inline-flex items-center gap-0.5">
            <Target size={11} /> 对话焦点
          </span>
          {focus.length === 0 && (
            <span className="text-[11px] text-slate-400">未指定（默认针对整份简历）</span>
          )}
          {focus.map((f) => (
            <span
              key={f}
              className="inline-flex items-center gap-0.5 text-[11px] bg-brand-50 text-brand-700 border border-brand-200 rounded px-1.5 py-[1px]"
            >
              <button onClick={() => onGoto(f)} title="定位到编辑器" className="hover:underline">
                {fieldToLabel(f)}
              </button>
              <button
                onClick={() => applyFocus(focus.filter((x) => x !== f))}
                className="text-brand-400 hover:text-brand-700"
                title="移除焦点"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <div className="relative">
            <button
              onClick={() => setPicker((p) => (p === "focus" ? null : "focus"))}
              className="text-[11px] text-brand-600 hover:bg-brand-50 border border-dashed border-brand-300 rounded px-1.5 py-[1px] transition"
            >
              + 添加焦点
            </button>
            {picker === "focus" && (
              <div className="absolute z-20 mt-1 left-0 w-64 rounded-xl border border-slate-200 bg-white shadow-xl max-h-64 overflow-y-auto">
                {fieldOptions.length === 0 && (
                  <div className="px-3 py-2 text-xs text-slate-400">简历还没有可引用的内容</div>
                )}
                {fieldOptions.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => addFocus(o.value)}
                    className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-brand-50 transition"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setJdOpen((v) => !v)}
            className={`ml-auto text-[11px] inline-flex items-center gap-0.5 px-1.5 py-[1px] rounded border transition ${
              jd.trim()
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "text-slate-500 border-slate-200 hover:bg-slate-50"
            }`}
          >
            <Target size={11} /> JD 定向{jd.trim() ? " · 已填" : ""}
          </button>
        </div>
        {jdOpen && (
          <div className="mt-2">
            <textarea
              rows={3}
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              onBlur={saveJd}
              placeholder="粘贴目标岗位 JD，对话时会同时参考它"
              className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        )}
      </div>

      {/* ---- 消息区 ---- */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {!resumeId && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>请先保存简历后再对话，AI 需要读取已保存的内容才能给出可应用的修改。</span>
          </div>
        )}

        {llmAvailable === false && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>未配置 AI 模型，无法进行对话。点右上角齿轮配置 LLM 后即可使用。</span>
          </div>
        )}

        {/* 体检待办 */}
        {tasks.length > 0 && tasksOpen && (
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-slate-100">
              <ListChecks size={14} className="text-brand-600" />
              <span className="text-xs font-medium text-slate-700">体检待办（{tasks.length}）</span>
              <button
                onClick={() => setTasksOpen(false)}
                className="ml-auto text-slate-400 hover:text-slate-600"
                title="收起"
              >
                <X size={12} />
              </button>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {tasks.map((t) => (
                <div key={t.id} className="flex items-start gap-2 px-3 py-2 border-b border-slate-50 last:border-b-0">
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${severityDot(t.severity)}`} />
                  <span className="text-xs text-slate-700 flex-1 min-w-0">
                    {t.title}
                    {t.field && (
                      <button
                        onClick={() => onGoto(t.field!)}
                        className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-brand-600 hover:underline"
                      >
                        <CornerDownRight size={9} />
                        {fieldToLabel(t.field)}
                      </button>
                    )}
                  </span>
                  <button
                    onClick={() => setInput(t.prompt)}
                    className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-brand-200 text-brand-700 hover:bg-brand-50 transition"
                  >
                    让 AI 处理
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {tasks.length > 0 && !tasksOpen && (
          <button
            onClick={() => setTasksOpen(true)}
            className="w-full text-[11px] text-brand-600 hover:bg-brand-50 border border-dashed border-brand-200 rounded-lg px-3 py-1.5 transition"
          >
            <ListChecks size={11} className="inline mr-1" />
            展开体检待办（{tasks.length}）
          </button>
        )}

        {busy && messages.length === 0 && (
          <div className="flex items-center justify-center py-10 text-slate-400">
            <Loader2 size={16} className="animate-spin mr-2" />
            <span className="text-xs">正在加载对话…</span>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            {m.role === "user" ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600 text-white text-sm px-3 py-2 whitespace-pre-wrap">
                {m.content}
              </div>
            ) : (
              <div className="space-y-2">
                {m.reasoning && (
                  <details className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden">
                    <summary className="flex items-center gap-1.5 px-3 py-2 cursor-pointer select-none text-xs text-slate-600 hover:bg-slate-100">
                      <Brain size={12} className="text-slate-400 shrink-0" />
                      <span className="font-medium">思考过程</span>
                      <span className="text-[10px] text-slate-400 ml-auto">{m.reasoning.length} 字</span>
                    </summary>
                    <pre className="px-3 pb-3 text-[11px] leading-relaxed text-slate-500 whitespace-pre-wrap max-h-48 overflow-y-auto">
                      {m.reasoning}
                    </pre>
                  </details>
                )}
                <div className="rounded-2xl rounded-bl-sm bg-white border border-slate-200 px-3 py-2 text-slate-800">
                  <MarkdownLite text={m.content} />
                </div>
                {m.edits && m.edits.length > 0 && (
                  <div className="space-y-2">
                    {m.edits.map((e, i) => {
                      const revertible = revisions.some(
                        (r) =>
                          !r.revertedAt &&
                          ((e.op === "append" && e.itemId && r.itemId === e.itemId) ||
                            (e.op === "set" && e.field && r.field === e.field))
                      );
                      return (
                        <EditCard
                          key={i}
                          edit={e}
                          applied={m.appliedIndexes.includes(i)}
                          disabled={!resumeId}
                          onApply={(edited) => applyChatEdit(m, i, edited)}
                          onRevert={revertible ? () => revertChatEdit(e, m, i) : undefined}
                          onGoto={onGoto}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {streaming && (
          <div className="space-y-2">
            {reasoning && (
              <details open className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden">
                <summary className="flex items-center gap-1.5 px-3 py-2 cursor-pointer select-none text-xs text-slate-600">
                  <Brain size={12} className="text-slate-400 shrink-0" />
                  <span className="font-medium">思考中…</span>
                </summary>
                <pre className="px-3 pb-3 text-[11px] leading-relaxed text-slate-500 whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {reasoning}
                </pre>
              </details>
            )}
            <div className="rounded-2xl rounded-bl-sm bg-white border border-slate-200 px-3 py-2 text-slate-800">
              {streamText ? (
                <MarkdownLite text={streamText} />
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                  <Loader2 size={12} className="animate-spin" /> 正在思考…
                </span>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        )}
      </div>

      {/* ---- 快捷指令 + 输入区 ---- */}
      <div className="shrink-0 border-t border-slate-100 px-4 py-2 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {QUICK_ACTIONS.map((q) => (
            <button
              key={q}
              onClick={() => {
                const suffix = focus.length ? `（聚焦：${focus.map(fieldToLabel).join("、")}）` : "";
                setInput(q + suffix);
              }}
              disabled={disabledInput}
              className="text-[11px] px-2 py-0.5 rounded-full border border-slate-200 text-slate-600 hover:border-brand-300 hover:text-brand-700 hover:bg-brand-50 transition disabled:opacity-40"
            >
              {q}
            </button>
          ))}
        </div>

        <div className="relative">
          <textarea
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!disabledInput && input.trim()) send();
              }
            }}
            disabled={disabledInput}
            placeholder={
              !resumeId
                ? "请先保存简历"
                : llmAvailable === false
                  ? "未配置 AI 模型，无法对话"
                  : "描述你想补全或优化的内容；@ 可引用简历中的某段（Enter 发送 / Shift+Enter 换行）"
            }
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-50 disabled:text-slate-400"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <div className="relative">
              <button
                onClick={() => setPicker((p) => (p === "at" ? null : "at"))}
                disabled={disabledInput}
                title="引用简历中的某段（@）"
                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-brand-600 hover:border-brand-300 transition disabled:opacity-40"
              >
                <AtSign size={14} />
              </button>
              {picker === "at" && (
                <div className="absolute z-20 bottom-full mb-1 left-0 w-64 rounded-xl border border-slate-200 bg-white shadow-xl max-h-64 overflow-y-auto">
                  {fieldOptions.length === 0 && (
                    <div className="px-3 py-2 text-xs text-slate-400">简历还没有可引用的内容</div>
                  )}
                  {fieldOptions.map((o) => (
                    <button
                      key={o.value}
                      onClick={() => addRef(o.value)}
                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-brand-50 transition"
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {streaming ? (
              <button
                onClick={stop}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 transition"
              >
                <Square size={12} /> 停止
              </button>
            ) : (
              <button
                onClick={() => send()}
                disabled={disabledInput || !input.trim()}
                className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={12} /> 发送
              </button>
            )}

            <button
              onClick={retry}
              disabled={disabledInput || streaming || !messages.some((m) => m.role === "user")}
              title="重发上一条提问"
              className="inline-flex items-center gap-1 text-xs px-2 py-1.5 rounded-lg text-slate-500 hover:text-brand-600 hover:bg-slate-100 transition disabled:opacity-40"
            >
              <RefreshCw size={12} /> 重试
            </button>

            {revisions.some((r) => !r.revertedAt) && (
              <span className="ml-auto text-[10px] text-slate-400 inline-flex items-center gap-1">
                <Check size={10} className="text-emerald-500" />
                已应用 {revisions.filter((r) => !r.revertedAt).length} 处，可在「修改历史」撤销
              </span>
            )}
            {!revisions.some((r) => !r.revertedAt) && (
              <span className="ml-auto text-[10px] text-slate-300 inline-flex items-center gap-1">
                <Sparkles size={10} /> AI 只给建议，应用与否由你决定
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}