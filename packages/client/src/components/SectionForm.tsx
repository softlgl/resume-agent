import { Trash2, Plus } from "lucide-react";

// 用一个简单 id 生成（避免引入额外依赖）
function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface FieldDef {
  key: string;
  label: string;
  type?: "text" | "textarea" | "date" | "month" | "checkbox";
}

export interface SectionFormProps<T> {
  title: string;
  items: T[];
  fields: FieldDef[];
  empty: () => T;
  onChange: (items: T[]) => void;
  renderExtra?: (item: T, index: number) => React.ReactNode;
}

export default function SectionForm<T extends { id: string }>({
  title,
  items,
  fields,
  empty,
  onChange,
}: SectionFormProps<T>) {
  const update = (index: number, patch: Partial<T>) => {
    const next = items.map((it, i) => (i === index ? { ...it, ...patch } : it));
    onChange(next);
  };
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index));
  const add = () => onChange([...items, { ...empty(), id: uid() } as T]);

  return (
    <div className="glass rounded-2xl p-4 mb-4 shadow-glass">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-slate-800">{title}</h2>
        <button
          onClick={add}
          className="flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition"
        >
          <Plus size={14} /> 添加
        </button>
      </div>
      {items.length === 0 && <p className="text-sm text-slate-400">暂无内容，点击「添加」开始填写。</p>}
      <div className="space-y-3">
        {items.map((item, idx) => (
          <div key={item.id} className="border border-slate-200 rounded-xl p-3 bg-white/60">
            <div className="flex justify-end mb-2">
              <button
                onClick={() => remove(idx)}
                className="text-red-500 hover:text-red-700 transition"
                title="删除"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {fields.map((f) => (
                <label key={f.key} className={f.type === "textarea" ? "col-span-2" : ""}>
                  <span className="text-xs text-slate-500">{f.label}</span>
                  {f.type === "textarea" ? (
                    <textarea
                      className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
                      rows={3}
                      value={(item as any)[f.key] ?? ""}
                      onChange={(e) => update(idx, { [f.key]: e.target.value } as Partial<T>)}
                    />
                  ) : f.type === "checkbox" ? (
                    <input
                      type="checkbox"
                      className="ml-2"
                      checked={!!(item as any)[f.key]}
                      onChange={(e) => update(idx, { [f.key]: e.target.checked } as Partial<T>)}
                    />
                  ) : f.type === "month" ? (
                    <input
                      type="month"
                      className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                      value={(item as any)[f.key] ?? ""}
                      onChange={(e) => update(idx, { [f.key]: e.target.value } as Partial<T>)}
                    />
                  ) : (
                    <input
                      type="text"
                      className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                      value={(item as any)[f.key] ?? ""}
                      onChange={(e) => update(idx, { [f.key]: e.target.value } as Partial<T>)}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
