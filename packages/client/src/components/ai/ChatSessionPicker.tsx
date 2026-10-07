import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import type { ChatSessionMeta } from "@resume-agent/shared";

interface Props {
  sessions: ChatSessionMeta[];
  currentId: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function ChatSessionPicker({
  sessions,
  currentId,
  disabled,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = sessions.find((s) => s.id === currentId);

  return (
    <div ref={boxRef} className="relative flex-1 min-w-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-left hover:border-brand-300 transition disabled:opacity-50"
      >
        <span className="text-xs text-slate-700 truncate flex-1 min-w-0">
          {current?.title || "选择对话"}
        </span>
        <span className="text-[10px] text-slate-400 shrink-0">
          {current ? `${current.messageCount} 条` : ""}
        </span>
        <ChevronDown size={13} className="text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 left-0 right-0 rounded-xl border border-slate-200 bg-white shadow-xl max-h-72 overflow-y-auto">
          <button
            onClick={() => {
              onCreate();
              setOpen(false);
            }}
            className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-brand-700 hover:bg-brand-50 border-b border-slate-100 transition"
          >
            <MessageSquarePlus size={13} /> 新建对话
          </button>

          {sessions.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-400">还没有历史对话</div>
          )}

          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group flex items-center gap-1 px-3 py-2 border-b border-slate-50 last:border-b-0 hover:bg-slate-50 ${
                s.id === currentId ? "bg-brand-50/60" : ""
              }`}
            >
              {editingId === s.id ? (
                <>
                  <input
                    autoFocus
                    className="flex-1 min-w-0 text-xs border border-slate-200 rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onRename(s.id, draft.trim() || s.title);
                        setEditingId(null);
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      onRename(s.id, draft.trim() || s.title);
                      setEditingId(null);
                    }}
                    className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"
                    title="确认"
                  >
                    <Check size={12} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      onSelect(s.id);
                      setOpen(false);
                    }}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className="text-xs text-slate-700 truncate">{s.title}</div>
                    <div className="text-[10px] text-slate-400">
                      {fmtTime(s.lastMessageAt)}
                      {s.preview ? ` · ${s.preview}` : ""}
                    </div>
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(s.id);
                      setDraft(s.title);
                    }}
                    className="p-1 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded opacity-0 group-hover:opacity-100 transition"
                    title="重命名"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => onDelete(s.id)}
                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition"
                    title="删除"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}