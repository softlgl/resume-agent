import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { TEMPLATES } from "@resume-agent/shared";
import { useResumeStore } from "../store/resume";
import { X } from "lucide-react";

// 新建简历对话框：第 1 步选模板，第 2 步选「空白」或「复制当前」
export default function NewResumeDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { createNew, id } = useResumeStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [templateId, setTemplateId] = useState("classic");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  const hasCurrent = !!id;

  const finish = async (fromCurrent: boolean) => {
    setCreating(true);
    setErr("");
    const newId = await createNew(templateId, fromCurrent);
    setCreating(false);
    if (newId) {
      onClose();
      navigate(`/editor/${newId}`);
    } else {
      setErr("新建失败，请重试");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-600"
          aria-label="关闭"
        >
          <X size={20} />
        </button>

        {step === 1 && (
          <>
            <h2 className="text-lg font-bold text-slate-800 mb-1">新建简历</h2>
            <p className="text-sm text-slate-500 mb-4">第 1 步 · 选择模板</p>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {TEMPLATES.map((t) => {
                const selected = t.id === templateId;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTemplateId(t.id)}
                    className="rounded-xl p-2 text-left transition"
                    style={{
                      outline: selected ? `2px solid ${t.colors.primary}` : "2px solid transparent",
                    }}
                  >
                    <div
                      className="h-14 rounded-lg mb-1.5 flex items-center justify-center text-white text-xs font-semibold"
                      style={{ background: t.layout === "two-column" ? t.colors.sidebar : t.colors.primary }}
                    >
                      {t.layout === "two-column" ? "双栏" : "单栏"}
                    </div>
                    <p className="text-xs font-semibold text-slate-800">{t.name}</p>
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setStep(2)}
                className="px-4 py-2 rounded-lg bg-brand-600 text-white text-sm hover:bg-brand-700"
              >
                下一步
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="text-lg font-bold text-slate-800 mb-1">新建简历</h2>
            <p className="text-sm text-slate-500 mb-4">第 2 步 · 选择初始内容</p>
            <div className="space-y-3 mb-6">
              <button
                onClick={() => finish(false)}
                disabled={creating}
                className="w-full text-left p-4 rounded-xl border-2 border-slate-200 hover:border-brand-500 transition disabled:opacity-60"
              >
                <p className="font-semibold text-slate-800">空白简历</p>
                <p className="text-xs text-slate-500 mt-0.5">从零开始填写</p>
              </button>
              {hasCurrent && (
                <button
                  onClick={() => finish(true)}
                  disabled={creating}
                  className="w-full text-left p-4 rounded-xl border-2 border-slate-200 hover:border-brand-500 transition disabled:opacity-60"
                >
                  <p className="font-semibold text-slate-800">复制当前简历</p>
                  <p className="text-xs text-slate-500 mt-0.5">基于当前简历内容创建副本，适合做岗位变体</p>
                </button>
              )}
            </div>
            <div className="flex justify-between">
              <button
                onClick={() => setStep(1)}
                disabled={creating}
                className="px-4 py-2 rounded-lg bg-slate-100 text-slate-600 text-sm hover:bg-slate-200"
              >
                上一步
              </button>
              {err && <span className="text-sm text-red-500 self-center">{err}</span>}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
