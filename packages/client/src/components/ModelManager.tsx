import { useState, useEffect, useCallback } from "react";
import { Check, ChevronLeft } from "lucide-react";
import { api, type AIProfile } from "../api/client";

// 与后端 DEFAULTS 对齐的各家默认上下/输出上限（新增模型时按 provider 预填）
const PROVIDER_LIMITS: Record<string, { maxContext: number; maxOutput: number }> = {
  openai: { maxContext: 128000, maxOutput: 16384 },
  deepseek: { maxContext: 128000, maxOutput: 8192 },
  doubao: { maxContext: 128000, maxOutput: 8192 },
  qwen: { maxContext: 131072, maxOutput: 8192 },
  ollama: { maxContext: 32768, maxOutput: 4096 },
  lmstudio: { maxContext: 32768, maxOutput: 4096 },
  vllm: { maxContext: 32768, maxOutput: 4096 },
};
const DEFAULT_LIMITS = PROVIDER_LIMITS.ollama;

// 全局 LLM 模型管理：多模型 profiles 的增删改 / 切换当前模型。
// 采用「同一层内视图切换」：列表视图 ↔ 表单视图，不在弹窗上再叠加弹窗，
// 减少层级、体验更顺。作为全局设置在多个入口复用（AI 分析面板、编辑器顶栏等）。
export default function ModelManager({ open }: { open: boolean }) {
  // view = "list" | "form"：主界面在列表与新增/编辑表单间切换
  const [view, setView] = useState<"list" | "form">("list");
  const [editing, setEditing] = useState<AIProfile | null>(null);
  const [models, setModels] = useState<AIProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const r = await api.aiGetConfig();
      setModels(r.profiles ?? []);
      setActiveId(r.activeId ?? null);
    } catch {}
  }, []);

  // 打开时回到列表并刷新
  useEffect(() => {
    if (open) {
      setView("list");
      loadConfig();
    }
  }, [open, loadConfig]);

  const openAdd = () => { setEditing(null); setView("form"); };
  const openEdit = (m: AIProfile) => { setEditing(m); setView("form"); };

  const handleSwitch = async (id: string) => {
    try { await api.aiSwitchProfile(id); } catch {}
    await loadConfig();
  };

  const handleRemove = async (id: string) => {
    try { await api.aiRemoveProfile(id); } catch {}
    await loadConfig();
  };

  const handleResetAll = async () => {
    try { await api.aiResetConfig(); } catch {}
    await loadConfig();
  };

  if (!open) return null;

  if (view === "form") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <button
            onClick={() => setView("list")}
            className="flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition"
            title="返回模型列表"
          >
            <ChevronLeft size={16} />
          </button>
          {editing ? "编辑模型" : "新增模型"}
        </div>
        <ModelForm
          editing={editing}
          onCancel={() => setView("list")}
          onSaved={() => { setView("list"); loadConfig(); }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>LLM 模型配置（全局）</span>
        <div className="flex items-center gap-3">
          <button onClick={handleResetAll} className="text-slate-400 hover:text-slate-600 transition">清空配置</button>
          <button onClick={openAdd} className="text-brand-600 hover:text-brand-700 transition">+ 新增模型</button>
        </div>
      </div>

      {/* 当前模型快速切换 */}
      {models.length > 0 && (
        <label className="block text-xs text-slate-500">
          当前模型
          <select
            value={activeId ?? ""}
            onChange={(e) => { const id = e.target.value; if (id && id !== activeId) handleSwitch(id); }}
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}{m.active ? "（当前）" : ""}</option>
            ))}
          </select>
        </label>
      )}

      {/* 模型列表 */}
      {models.length === 0 ? (
        <div className="text-xs text-slate-400">尚未配置模型，请点击上方"新增模型"。</div>
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <div key={m.id} className={`rounded-lg border p-2.5 text-xs ${m.active ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white"}`}>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-700">{m.name}</span>
                {m.active && <span className="text-[10px] bg-brand-600 text-white px-1.5 py-0.5 rounded">当前</span>}
              </div>
              <div className="mt-1 text-slate-500 leading-relaxed">
                {m.provider} · {m.model}<br />
                {m.baseUrl}<br />
                API Key: {m.apiKeyMasked || "—"}
              </div>
              <div className="mt-1.5 flex items-center gap-3">
                {!m.active && (
                  <button onClick={() => handleSwitch(m.id)} className="text-brand-600 hover:text-brand-700">设为当前</button>
                )}
                <button onClick={() => openEdit(m)} className="text-slate-500 hover:text-slate-700">编辑</button>
                <button onClick={() => handleRemove(m.id)} className="text-red-500 hover:text-red-700">删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 新增 / 编辑模型表单（同一层内联切换，非弹窗）
function ModelForm({
  editing,
  onCancel,
  onSaved,
}: {
  editing: AIProfile | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    provider: editing?.provider ?? "ollama",
    baseUrl: editing?.baseUrl ?? "http://localhost:11434/v1",
    model: editing?.model ?? "",
    maxContext: editing?.maxContext ?? (PROVIDER_LIMITS[editing?.provider ?? ""] ?? DEFAULT_LIMITS).maxContext,
    maxOutput: editing?.maxOutput ?? (PROVIDER_LIMITS[editing?.provider ?? ""] ?? DEFAULT_LIMITS).maxOutput,
    apiKey: "",
  });
  const [llmStatus, setLlmStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const handleSave = async () => {
    setLlmStatus("saving");
    try {
      if (editing) {
        await api.aiUpdateProfile(editing.id, {
          name: form.name,
          provider: form.provider,
          baseUrl: form.baseUrl,
          model: form.model,
          maxContext: Number(form.maxContext) || undefined,
          maxOutput: Number(form.maxOutput) || undefined,
          apiKey: form.apiKey || undefined,
        });
      } else {
        await api.aiAddProfile({
          name: form.name,
          provider: form.provider,
          baseUrl: form.baseUrl,
          model: form.model,
          maxContext: Number(form.maxContext) || undefined,
          maxOutput: Number(form.maxOutput) || undefined,
          apiKey: form.apiKey,
        });
      }
      onSaved();
    } catch {
      setLlmStatus("failed");
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <label className="block text-xs text-slate-500">
        名称（可选）
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
          placeholder="如 本机 Ollama"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-500">
          Provider
          <select
                value={form.provider}
                onChange={(e) => {
                  const p = e.target.value;
                  const limits = PROVIDER_LIMITS[p] ?? DEFAULT_LIMITS;
                  // 新增场景下切换 provider 时重置上限默认值；编辑场景保留用户已填值
                  setForm(
                    editing
                      ? { ...form, provider: p }
                      : { ...form, provider: p, maxContext: limits.maxContext, maxOutput: limits.maxOutput }
                  );
                }}
                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
              >
            <option value="ollama">Ollama (本地)</option>
            <option value="lmstudio">LM Studio (本地)</option>
            <option value="vllm">vLLM (本地)</option>
            <option value="deepseek">DeepSeek</option>
            <option value="doubao">豆包</option>
            <option value="qwen">通义千问</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label className="text-xs text-slate-500">
          模型名称
          <input
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
            placeholder="如 qwen3.5:4b"
          />
        </label>
      </div>
      <label className="block text-xs text-slate-500">
        Base URL
        <input
          value={form.baseUrl}
          onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
          placeholder="http://localhost:11434/v1"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-500">
          最大输入(token)
          <input
            type="number"
            min={1}
            value={form.maxContext}
            onChange={(e) => setForm({ ...form, maxContext: Number(e.target.value) })}
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          最大输出(token)
          <input
            type="number"
            min={1}
            value={form.maxOutput}
            onChange={(e) => setForm({ ...form, maxOutput: Number(e.target.value) })}
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      {!["ollama", "lmstudio", "vllm"].includes(form.provider) && (
        <label className="block text-xs text-slate-500">
          API Key{editing ? "（留空则不修改）" : ""}
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
            placeholder="sk-..."
          />
        </label>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={llmStatus === "saving"}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-brand-600 text-white text-sm py-1.5 hover:bg-brand-700 transition disabled:opacity-60"
        >
          {llmStatus === "saving" && "保存中..."}
          {llmStatus === "saved" && <><Check size={14} /> 已保存</>}
          {llmStatus === "failed" && "保存失败"}
          {llmStatus === "idle" && (editing ? "保存修改" : "新增并保存")}
        </button>
        <button
          onClick={onCancel}
          disabled={llmStatus === "saving"}
          className="px-3 py-1.5 rounded-md border border-slate-200 text-slate-500 text-sm hover:bg-slate-50 transition disabled:opacity-60"
        >
          取消
        </button>
      </div>
    </div>
  );
}