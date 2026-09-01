import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useResumeStore } from "../store/resume";
import { ChevronDown, Plus, Trash2, FileText } from "lucide-react";
import NewResumeDialog from "./NewResumeDialog";

// 顶部「我的简历 ▾」下拉：列表 / 切换 / 新建 / 删除
export default function ResumeSwitcher() {
  const navigate = useNavigate();
  const { id, title, list, loadList, remove } = useResumeStore();
  const [open, setOpen] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 首次打开下拉时拉一次列表（保证最新）
  useEffect(() => {
    if (open && list.length === 0) loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点外部关闭（但点击删除按钮/确认弹窗内部时不关闭，避免误触）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // 确认弹窗通过 portal 渲染到 body，不在 ref 内，但其内部点击不应关闭下拉
      if (confirmDel) return;
      if (ref.current && !ref.current.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, confirmDel]);

  const switchTo = (rid: string) => {
    setOpen(false);
    if (rid !== id) navigate(`/editor/${rid}`);
  };

  const onDelete = async (rid: string) => {
    const wasCurrent = rid === id;
    await remove(rid);
    setConfirmDel(null);
    setOpen(false);
    // 如果删除的是当前简历，store.remove 已切到第一份；同步 URL
    if (wasCurrent) {
      const newId = useResumeStore.getState().id;
      navigate(newId ? `/editor/${newId}` : "/editor");
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/60 transition text-sm font-medium text-slate-700 max-w-[200px]"
        title="切换 / 管理简历"
      >
        <FileText size={15} className="text-slate-400 shrink-0" />
        <span className="truncate">{title || "我的简历"}</span>
        <ChevronDown size={14} className="text-slate-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 glass rounded-xl shadow-glass p-1 z-20 max-h-[70vh] overflow-y-auto">
          {/* 列表 */}
          {list.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-slate-400">
              {list.length === 0 ? "还没有简历，新建一份吧" : "加载中…"}
            </div>
          ) : (
            list.map((r) => (
              <div
                key={r.id}
                className={`flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/70 cursor-pointer group ${
                  r.id === id ? "bg-white/80" : ""
                }`}
                onClick={() => switchTo(r.id)}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{r.title || "未命名"}</p>
                  <p className="text-[11px] text-slate-400">
                    {new Date(r.updatedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} · {r.templateId}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDel(r.id);
                  }}
                  className="text-slate-400 hover:text-red-500 transition p-1"
                  title="删除"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}

          {/* 新建按钮 */}
          <button
            onClick={() => {
              setOpen(false);
              setShowNew(true);
            }}
            className="w-full mt-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-50 text-brand-700 text-sm font-medium hover:bg-brand-100 transition"
          >
            <Plus size={16} /> 新建简历
          </button>
        </div>
      )}

      {/* 删除确认 */}
      {confirmDel && createPortal(
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4"
          onClick={() => setConfirmDel(null)}
        >
          <div className="bg-white rounded-2xl p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <p className="text-slate-800 font-semibold mb-1">删除简历？</p>
            <p className="text-sm text-slate-500 mb-4">该操作不可恢复，简历内容将永久丢失。</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDel(null)}
                className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-sm hover:bg-slate-200"
              >
                取消
              </button>
              <button
                onClick={() => onDelete(confirmDel)}
                className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-sm hover:bg-red-600"
              >
                删除
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showNew && <NewResumeDialog onClose={() => setShowNew(false)} />}
    </div>
  );
}
