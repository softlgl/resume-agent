import { TEMPLATES } from "@resume-agent/shared";

export default function TemplatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto px-2 pb-2 pt-1">
      {TEMPLATES.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`shrink-0 w-28 rounded-xl p-2 text-left transition-all duration-200 bg-white border border-slate-200 relative ${selected ? "z-10" : ""}`}
            style={{
              outline: selected ? `2px solid ${t.colors.primary}` : "2px solid transparent",
              transform: selected ? "scale(1.04)" : "scale(1)",
            }}
          >
            <div
              className="h-16 rounded-lg mb-2 flex items-center justify-center text-white text-xs font-semibold"
              style={{
                background: t.layout === "two-column" ? t.colors.sidebar : t.colors.primary,
              }}
            >
              {t.layout === "two-column" ? "双栏" : "单栏"}
            </div>
            <p className="text-sm font-semibold text-slate-800">{t.name}</p>
            <p className="text-[11px] text-slate-500 leading-tight">{t.description.slice(0, 10)}…</p>
          </button>
        );
      })}
    </div>
  );
}
