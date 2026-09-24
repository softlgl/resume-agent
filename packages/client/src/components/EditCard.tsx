import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CornerDownRight,
  EyeOff,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { wordDiff } from "../utils/diff";
import type { EditSection, ResumeEdit } from "@resume-agent/shared";

// 应用结果：供 Editor 记账（before/after）与调用方提示
export type ApplyResult =
  | {
      ok: true;
      label: string;
      field: string;
      beforeValue: string | null;
      afterValue: string | null;
      itemId: string | null;
    }
  | { ok: false; error: string };

interface Props {
  edit: ResumeEdit;
  applied: boolean;
  onApply: (edit: ResumeEdit) => Promise<ApplyResult>;
  onGoto?: (field: string) => void;
  onRevert?: () => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// append 卡片表单的字段元信息（与后端 SETTABLE_FIELDS / APPEND_REQUIRED 口径一致）
// ---------------------------------------------------------------------------
interface FieldMeta {
  key: string;
  label: string;
  type?: "text" | "textarea" | "month" | "checkbox";
  placeholder?: string;
}

const FIELD_META: Record<Exclude<EditSection, "basic">, FieldMeta[]> = {
  works: [
    { key: "company", label: "公司名称", placeholder: "待补充" },
    { key: "role", label: "职位", placeholder: "待补充" },
    { key: "start", label: "开始时间", type: "month" },
    { key: "end", label: "结束时间", type: "month", placeholder: "至今可留空" },
    { key: "current", label: "至今（在职中）", type: "checkbox" },
    { key: "description", label: "工作描述", type: "textarea", placeholder: "做了什么、带来了什么结果" },
  ],
  educations: [
    { key: "school", label: "学校", placeholder: "待补充" },
    { key: "major", label: "专业", placeholder: "待补充" },
    { key: "degree", label: "学历", placeholder: "如 本科" },
    { key: "start", label: "开始时间", type: "month" },
    { key: "end", label: "结束时间", type: "month" },
    { key: "description", label: "描述", type: "textarea" },
  ],
  projects: [
    { key: "name", label: "项目名称", placeholder: "待补充" },
    { key: "company", label: "所属公司", placeholder: "选填" },
    { key: "role", label: "担任角色", placeholder: "待补充" },
    { key: "start", label: "开始时间", type: "month" },
    { key: "end", label: "结束时间", type: "month" },
    { key: "link", label: "项目链接", placeholder: "选填" },
    { key: "description", label: "项目描述", type: "textarea", placeholder: "做了什么、技术方案、成果" },
  ],
  skills: [
    { key: "category", label: "技能分类", placeholder: "如 前端 / 后端" },
    { key: "items", label: "技能项", type: "textarea", placeholder: "逗号或换行分隔" },
  ],
};

const APPEND_REQUIRED: Record<Exclude<EditSection, "basic">, string[]> = {
  works: ["company", "role", "start"],
  educations: ["school", "start"],
  projects: ["name"],
  skills: ["category", "items"],
};

// ---------------------------------------------------------------------------
// 词级差异对比：删除红底删除线、新增绿底
// ---------------------------------------------------------------------------
function DiffView({ before, after }: { before: string; after: string }) {
  const tokens = useMemo(() => wordDiff(before, after), [before, after]);
  return (
    <div className="mt-2 text-xs leading-relaxed whitespace-pre-wrap rounded-lg bg-white border border-slate-200 px-2.5 py-2 max-h-60 overflow-y-auto">
      {tokens.map((t, i) => {
        if (t.type === "same") return <span key={i} className="text-slate-600">{t.text}</span>;
        if (t.type === "del")
          return (
            <span key={i} className="bg-red-100 text-red-700 line-through decoration-red-400 rounded-sm">
              {t.text}
            </span>
          );
        return (
          <span key={i} className="bg-emerald-100 text-emerald-800 rounded-sm">
            {t.text}
          </span>
        );
      })}
    </div>
  );
}

export default function EditCard({ edit, applied, onApply, onGoto, onRevert, disabled }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<Record<string, string | boolean>>(() => ({ ...(edit.item ?? {}) }));

  // 同一条消息里 edits 可能整体刷新（重试 / 重新拉取），同步一次表单初值
  useEffect(() => {
    setItem({ ...(edit.item ?? {}) });
    setError(null);
  }, [edit]);

  if (dismissed) return null;

  const isAppend = edit.op === "append";
  const section = edit.section as Exclude<EditSection, "basic">;
  const metas = isAppend ? FIELD_META[section] ?? [] : [];
  const missing = isAppend
    ? (APPEND_REQUIRED[section] ?? []).filter((k) => !String(item[k] ?? "").trim()).map(
        (k) => metas.find((m) => m.key === k)?.label ?? k
      )
    : [];
  const canApply = !disabled && !busy && missing.length === 0;

  const doApply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await onApply(isAppend ? { ...edit, item } : edit);
      if (!res.ok) setError(res.error);
    } catch (e: any) {
      setError(e?.message || "应用失败");
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="flex items-start gap-2">
      <Sparkles size={14} className="text-brand-500 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded px-1.5 py-[1px]">
            {isAppend ? "新增条目" : "改写"}
          </span>
          <span className="text-xs font-medium text-slate-700 truncate">{edit.label}</span>
          {edit.field && !isAppend && onGoto && (
            <button
              onClick={() => onGoto(edit.field!)}
              className="inline-flex items-center gap-0.5 text-[11px] text-brand-600 hover:bg-brand-50 px-1.5 py-0.5 rounded transition"
              title="定位到编辑器"
            >
              <CornerDownRight size={10} /> 定位
            </button>
          )}
        </div>
        {edit.reason && <div className="text-xs text-slate-500 mt-1">💡 {edit.reason}</div>}
      </div>
    </div>
  );

  // ---- 已应用态 ----
  if (applied) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-2.5">
        {header}
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-emerald-700">
          <CheckCircle2 size={12} /> 已应用到简历
          {onRevert && (
            <button
              onClick={onRevert}
              disabled={disabled}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-emerald-300 hover:bg-emerald-100 transition disabled:opacity-50"
            >
              <RotateCcw size={10} /> 撤销
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
      {header}

      {!isAppend && <DiffView before={edit.before ?? ""} after={edit.after ?? ""} />}

      {isAppend && (
        <div className="mt-2 rounded-lg bg-white border border-slate-200 p-2.5 grid grid-cols-2 gap-2">
          <div className="col-span-2 text-[11px] text-slate-500">
            AI 已预填它知道的内容，<span className="text-slate-700 font-medium">空着的部分请你补充</span>后即可应用。
          </div>
          {metas.map((m) => {
            const req = (APPEND_REQUIRED[section] ?? []).includes(m.key);

            if (m.type === "checkbox") {
              return (
                <label key={m.key} className="col-span-2 flex items-center gap-1.5 text-[11px] text-slate-600">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300 accent-brand-600"
                    checked={item[m.key] === true}
                    onChange={(e) => setItem((s) => ({ ...s, [m.key]: e.target.checked }))}
                  />
                  {m.label}
                </label>
              );
            }

            const val = typeof item[m.key] === "string" ? (item[m.key] as string) : "";
            // 月份框只认 YYYY-MM，非法值在浏览器里会被静默显示为空，这里显式提示原文
            const badMonth = m.type === "month" && !!val && !/^\d{4}-\d{2}$/.test(val);
            const lockedEnd = m.key === "end" && item.current === true;

            return (
              <label key={m.key} className={m.type === "textarea" ? "col-span-2" : ""}>
                <span className="text-[11px] text-slate-500">
                  {m.label}
                  {req && <span className="text-red-500 ml-0.5">*</span>}
                </span>
                {m.type === "textarea" ? (
                  <textarea
                    rows={3}
                    className="w-full mt-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
                    placeholder={m.placeholder}
                    value={val}
                    onChange={(e) => setItem((s) => ({ ...s, [m.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    type={m.type === "month" ? "month" : "text"}
                    className="w-full mt-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-100 disabled:text-slate-400"
                    placeholder={m.placeholder}
                    disabled={lockedEnd}
                    value={lockedEnd || badMonth ? "" : val}
                    onChange={(e) => setItem((s) => ({ ...s, [m.key]: e.target.value }))}
                  />
                )}
                {badMonth && (
                  <span className="block mt-0.5 text-[10px] text-amber-600">
                    AI 给的原文是「{val}」，不是月份格式，请重新选一个月份
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}

      {edit.risks && edit.risks.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
          <div className="flex items-center gap-1 font-medium">
            <AlertTriangle size={12} /> 可能引入了原文没有的信息
          </div>
          <ul className="list-disc pl-4 mt-0.5 space-y-0.5">
            {edit.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {error && <div className="mt-2 text-[11px] text-red-600">{error}</div>}

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={doApply}
          disabled={!canApply}
          className="inline-flex items-center gap-1 text-[11px] bg-brand-600 text-white px-2.5 py-1 rounded hover:bg-brand-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          应用到简历
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700 px-2 py-1 rounded hover:bg-slate-100 transition"
        >
          <EyeOff size={12} /> 忽略
        </button>
        {missing.length > 0 && (
          <span className="text-[11px] text-red-500">还需填写：{missing.join("、")}</span>
        )}
      </div>
    </div>
  );
}