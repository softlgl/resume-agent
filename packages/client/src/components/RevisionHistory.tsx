import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, Loader2, RotateCcw } from "lucide-react";
import { api } from "../api/client";
import type { AiRevisionRecord } from "@resume-agent/shared";

interface Props {
  resumeId: string | null;
  refreshKey: number;
  onRevert: (r: AiRevisionRecord) => Promise<boolean>;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function RevisionHistory({ resumeId, refreshKey, onRevert }: Props) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<AiRevisionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!resumeId) {
      setRevisions([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.listRevisions(resumeId);
      setRevisions(res.revisions);
    } catch {
      /* 账本拉取失败不阻塞主流程 */
    } finally {
      setLoading(false);
    }
  }, [resumeId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const handleRevert = async (r: AiRevisionRecord) => {
    setBusyId(r.id);
    try {
      const ok = await onRevert(r);
      if (ok) await load();
    } finally {
      setBusyId(null);
    }
  };

  // 只允许撤销「最新一条未撤销」的记录，避免前后依赖错乱
  const revertibleId = revisions.find((r) => !r.revertedAt)?.id ?? null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 transition"
      >
        {open ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
        <History size={14} className="text-slate-500" />
        <span className="text-xs font-medium text-slate-700">修改历史（{revisions.length}）</span>
        {loading && <Loader2 size={12} className="animate-spin text-slate-400" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 max-h-64 overflow-y-auto">
          {revisions.length === 0 && (
            <div className="px-3 py-3 text-xs text-slate-400">暂无修改记录。应用一次 AI 建议后会出现在这里。</div>
          )}
          {revisions.map((r) => {
            const reverted = !!r.revertedAt;
            const canRevert = !reverted && r.id === revertibleId;
            return (
              <div
                key={r.id}
                className={`flex items-center gap-2 px-3 py-2 border-b border-slate-50 last:border-b-0 ${
                  reverted ? "opacity-60" : ""
                }`}
              >
                <span
                  className={`text-[10px] px-1.5 py-[1px] rounded border shrink-0 ${
                    r.source === "analysis"
                      ? "text-sky-700 bg-sky-50 border-sky-200"
                      : "text-brand-700 bg-brand-50 border-brand-200"
                  }`}
                >
                  {r.source === "analysis" ? "分析" : "对话"}
                </span>
                <span className={`text-xs flex-1 min-w-0 truncate ${reverted ? "line-through text-slate-400" : "text-slate-700"}`}>
                  {r.label}
                </span>
                <span className="text-[10px] text-slate-400 shrink-0">{fmtTime(r.createdAt)}</span>
                {reverted ? (
                  <span className="text-[10px] text-slate-400 shrink-0 w-14 text-right">已撤销</span>
                ) : (
                  <button
                    onClick={() => handleRevert(r)}
                    disabled={!canRevert || busyId === r.id}
                    title={canRevert ? "撤销这次修改" : "请先撤销更新的修改"}
                    className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 transition disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    {busyId === r.id ? <Loader2 size={10} className="animate-spin" /> : <RotateCcw size={10} />}
                    撤销
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}