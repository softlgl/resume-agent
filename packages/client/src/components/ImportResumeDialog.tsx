import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Loader2, Upload, X, FileText, Plus, Trash2, AlertTriangle, Brain, Braces } from "lucide-react";
import { TEMPLATES } from "@resume-agent/shared";
import { api } from "../api/client";
import { useResumeStore } from "../store/resume";

interface ParseResult {
  fileName: string;
  sourceText: string;
  ocrUsed: boolean;
  content: any | null;
  note?: string;
}

const INPUT =
  "w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-200 bg-white";
const LABEL = "block text-[11px] font-medium text-slate-500 mb-0.5";
const BTN_PRIMARY =
  "px-4 py-2 rounded-lg bg-brand-600 text-white text-sm hover:bg-brand-700 disabled:opacity-60 disabled:cursor-not-allowed transition";

function Field({
  label,
  value,
  onChange,
  multiline,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      {multiline ? (
        <textarea
          className={`${INPUT} min-h-[64px]`}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input className={INPUT} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

type CardItem = { id: string; [k: string]: any };
function CardView({
  title,
  items,
  renderFields,
  onAdd,
  onRemove,
  addLabel,
}: {
  title: string;
  items: CardItem[];
  renderFields: (it: CardItem, set: (patch: Record<string, any>) => void) => React.ReactNode;
  onAdd: () => void;
  onRemove: (id: string) => void;
  addLabel: string;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-1.5">
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        <button
          onClick={onAdd}
          className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
        >
          <Plus size={14} /> {addLabel}
        </button>
      </div>
      {items.length === 0 && <p className="text-xs text-slate-400 mb-2">（暂无）</p>}
      <div className="space-y-3">
        {items.map((it) => (
          <div key={it.id} className="rounded-xl border border-slate-200 p-3 bg-white relative">
            <button
              onClick={() => onRemove(it.id)}
              className="absolute top-2 right-2 text-slate-400 hover:text-red-500 transition"
              title="删除"
            >
              <Trash2 size={14} />
            </button>
            {renderFields(it, (patch) => {
              // 就地更新由外层通过 updateItemTo(cb) 实现，这里不直接改
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function ImportResumeDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [reasoning, setReasoning] = useState("");
  const [outText, setOutText] = useState("");
  const [content, setContent] = useState<any | null>(null);
  const [templateId, setTemplateId] = useState("classic");
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);

  // 打开弹窗时查询 LLM 是否可用，用于「未配置 AI 模型」前置提示
  useEffect(() => {
    api.aiHealth().then((r) => setLlmAvailable(r.llmAvailable)).catch(() => {});
  }, []);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr("");
    setParsing(true);
    setReasoning("");
    setOutText("");
    try {
      const res = await api.importResumeStream(
        file,
        (d) => setReasoning((prev) => prev + d),
        (d) => setOutText((prev) => prev + d)
      );
      setResult(res);
      setContent(res.content);
      setTemplateId("classic");
    } catch (e: any) {
      setErr(e.message || "解析失败");
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const patchContent = (updater: (c: any) => void) => {
    if (!content) return;
    const c = JSON.parse(JSON.stringify(content));
    updater(c);
    setContent(c);
  };

  const setBasic = (key: string, v: string) => patchContent((c) => (c.basic[key] = v));

  const onSave = async () => {
    if (!result || !content) return;
    setSaving(true);
    setErr("");
    try {
      const title = `导入 - ${result.fileName.replace(/\.[^.]+$/, "")}`;
      const res = await api.createResume({ title, templateId, content });
      await useResumeStore.getState().loadList();
      onClose();
      navigate(`/editor/${res.resume.id}`);
    } catch (e: any) {
      setErr(e.message || "保存失败");
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl relative flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-slate-400 hover:text-slate-600 z-10"
          aria-label="关闭"
        >
          <X size={20} />
        </button>

        <div className="p-6 pb-4 border-b border-slate-100">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Upload size={18} className="text-brand-600" /> 导入简历
          </h2>
        </div>

        {/* 文件选择区 */}
        <div className="p-6">
          <input
            ref={fileRef}
            type="file"
            accept=".docx,.pdf"
            className="hidden"
            onChange={(e) => pick(e.target.files?.[0])}
          />
          {/* 前置：未配置 AI 模型提示 */}
          {llmAvailable === false && !parsing && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>当前未配置 AI 模型，导入将只提取原文、不自动识别为字段（可先在「AI 分析」面板配置 LLM 后重试）。</span>
            </div>
          )}

          {!result && (
            <>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={parsing}
                className="w-full h-40 rounded-xl border-2 border-dashed border-slate-200 hover:border-brand-400 hover:bg-brand-50/40 transition flex flex-col items-center justify-center gap-2 disabled:opacity-60"
              >
                {parsing ? (
                  <>
                    <Loader2 size={24} className="animate-spin text-brand-500" />
                    <span className="text-sm text-slate-500">正在解析文件…</span>
                  </>
                ) : (
                  <>
                    <FileText size={28} className="text-slate-400" />
                    <span className="text-sm text-slate-600">点击选择 .docx / .pdf 文件</span>
                    <span className="text-xs text-slate-400">
                      自动提取内容并识别为可编辑字段，扫描版 PDF 会自动 OCR
                    </span>
                  </>
                )}
              </button>
              {err && <p className="mt-3 text-sm text-red-500">{err}</p>}
            </>
          )}

          {/* 思考过程与输出内容：解析中逐字累积，成功/失败后保留展示（不隐藏） */}
          {reasoning && (
            <details className="mt-3 bg-slate-50 border border-slate-200 rounded-lg overflow-hidden">
              <summary className="flex items-center gap-1.5 px-3 py-2 cursor-pointer select-none text-sm text-slate-600 hover:bg-slate-100">
                <Brain size={14} className="text-slate-400 shrink-0" />
                <span className="font-medium">AI 识别的思考过程</span>
                <span className="text-xs text-slate-400 ml-auto">
                  {parsing ? `生成中… ${reasoning.length} 字` : `${reasoning.length} 字`}
                </span>
              </summary>
              <pre className="px-3 pb-3 text-xs leading-relaxed text-slate-500 whitespace-pre-wrap max-h-48 overflow-y-auto">
                {reasoning}
              </pre>
            </details>
          )}
          {outText && (
            <details className="mt-3 bg-slate-50 border border-slate-200 rounded-lg overflow-hidden" open={!parsing}>
              <summary className="flex items-center gap-1.5 px-3 py-2 cursor-pointer select-none text-sm text-slate-600 hover:bg-slate-100">
                <Braces size={14} className="text-slate-400 shrink-0" />
                <span className="font-medium">AI 识别输出（JSON）</span>
                <span className="text-xs text-slate-400 ml-auto">
                  {parsing ? `生成中… ${outText.length} 字` : `${outText.length} 字`}
                </span>
              </summary>
              <pre className="px-3 pb-3 text-xs leading-relaxed text-slate-600 whitespace-pre-wrap max-h-48 overflow-y-auto">
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(outText), null, 2);
                  } catch {
                    return outText;
                  }
                })()}
              </pre>
            </details>
          )}
          {result && !content && (
            <div>
              <div className="flex items-center gap-2 text-amber-600 mb-2">
                <AlertTriangle size={16} />
                <span className="text-sm font-medium">{result.note || "未能自动识别为结构数据。"}</span>
              </div>
              {result.ocrUsed && (
                <p className="text-xs text-slate-400 mb-2">（该文件为扫描件，已通过 OCR 识别文本）</p>
              )}
              {llmAvailable === false && (
                <p className="text-xs text-amber-600 mb-2">未配置 AI 模型。配置 LLM 后重新导入即可自动识别为可编辑字段。</p>
              )}
              <Field
                label={llmAvailable === false ? "原文内容（仅提取原文，请手动整理）" : "原文内容（自动识别失败，请手动新建并粘贴）"}
                value={result.sourceText}
                onChange={() => {}}
                multiline
              />
            </div>
          )}
        </div>

        {/* 预览 + 编辑区 */}
        {result && content && (
          <>
            <div className="px-6 pb-4 flex items-center gap-2 flex-wrap">
              <span className="text-sm text-slate-600">
                已识别：<span className="font-medium text-slate-800">{result.fileName}</span>
              </span>
              {result.ocrUsed && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-600">OCR 识别</span>
              )}
              <span className="flex-1" />
              <span className="text-xs text-slate-500 mr-1">模板</span>
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTemplateId(t.id)}
                  className={`px-2 py-1 rounded-lg text-xs font-medium transition ${
                    t.id === templateId ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>

            <div className="px-6 space-y-5 overflow-y-auto pb-4">
              {/* 基本信息 */}
              <section>
                <h3 className="text-sm font-semibold text-slate-700 mb-1.5">基本信息</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 rounded-xl border border-slate-200 p-3 bg-white">
                  {BASIC_FIELDS.map((f) => (
                    <Field
                      key={f.key}
                      label={f.label}
                      value={content.basic[f.key] || ""}
                      multiline={f.multiline}
                      onChange={(v) => setBasic(f.key, v)}
                    />
                  ))}
                </div>
              </section>

              <CardView
                title="工作经历"
                items={content.works}
                addLabel="添加工作"
                onAdd={() =>
                  patchContent((c) =>
                    c.works.push({
                      id: `w${Date.now()}`,
                      company: "",
                      role: "",
                      start: "",
                      end: "",
                      current: false,
                      description: "",
                    })
                  )
                }
                onRemove={(id) => patchContent((c) => (c.works = c.works.filter((w: any) => w.id !== id)))}
                renderFields={(it, set) => (
                  <div className="grid grid-cols-2 gap-3 pr-7">
                    <Field label="公司" value={it.company || ""} onChange={(v) => patchContent((c) => (c.works.find((w: any) => w.id === it.id)!.company = v))} />
                    <Field label="职位" value={it.role || ""} onChange={(v) => patchContent((c) => (c.works.find((w: any) => w.id === it.id)!.role = v))} />
                    <Field label="开始时间" placeholder="如 2020-07" value={it.start || ""} onChange={(v) => patchContent((c) => (c.works.find((w: any) => w.id === it.id)!.start = v))} />
                    <Field label="结束时间" placeholder="至今可留空" value={it.end || ""} onChange={(v) => patchContent((c) => (c.works.find((w: any) => w.id === it.id)!.end = v))} />
                    <label className="flex items-center gap-2 text-sm text-slate-600 col-span-2">
                      <input
                        type="checkbox"
                        checked={!!it.current}
                        onChange={(e) => patchContent((c) => (c.works.find((w: any) => w.id === it.id)!.current = e.target.checked))}
                      />
                      至今 / 在职中
                    </label>
                    <div className="col-span-2">
                      <Field label="工作描述" multiline value={it.description || ""} onChange={(v) => patchContent((c) => (c.works.find((w: any) => w.id === it.id)!.description = v))} />
                    </div>
                  </div>
                )}
              />

              <CardView
                title="教育经历"
                items={content.educations}
                addLabel="添加教育"
                onAdd={() =>
                  patchContent((c) =>
                    c.educations.push({ id: `e${Date.now()}`, school: "", major: "", degree: "", start: "", end: "", description: "" })
                  )
                }
                onRemove={(id) => patchContent((c) => (c.educations = c.educations.filter((x: any) => x.id !== id)))}
                renderFields={(it) => (
                  <div className="grid grid-cols-2 gap-3 pr-7">
                    <Field label="学校" value={it.school || ""} onChange={(v) => patchContent((c) => (c.educations.find((x: any) => x.id === it.id)!.school = v))} />
                    <Field label="专业" value={it.major || ""} onChange={(v) => patchContent((c) => (c.educations.find((x: any) => x.id === it.id)!.major = v))} />
                    <Field label="学历" value={it.degree || ""} onChange={(v) => patchContent((c) => (c.educations.find((x: any) => x.id === it.id)!.degree = v))} />
                    <Field label="开始时间" value={it.start || ""} onChange={(v) => patchContent((c) => (c.educations.find((x: any) => x.id === it.id)!.start = v))} />
                    <Field label="结束时间" value={it.end || ""} onChange={(v) => patchContent((c) => (c.educations.find((x: any) => x.id === it.id)!.end = v))} />
                    <div className="col-span-2">
                      <Field label="描述" multiline value={it.description || ""} onChange={(v) => patchContent((c) => (c.educations.find((x: any) => x.id === it.id)!.description = v))} />
                    </div>
                  </div>
                )}
              />

              <CardView
                title="项目经历"
                items={content.projects}
                addLabel="添加项目"
                onAdd={() =>
                  patchContent((c) =>
                    c.projects.push({ id: `p${Date.now()}`, name: "", role: "", start: "", end: "", link: "", description: "" })
                  )
                }
                onRemove={(id) => patchContent((c) => (c.projects = c.projects.filter((x: any) => x.id !== id)))}
                renderFields={(it) => (
                  <div className="grid grid-cols-2 gap-3 pr-7">
                    <Field label="项目名" value={it.name || ""} onChange={(v) => patchContent((c) => (c.projects.find((x: any) => x.id === it.id)!.name = v))} />
                    <Field label="角色" value={it.role || ""} onChange={(v) => patchContent((c) => (c.projects.find((x: any) => x.id === it.id)!.role = v))} />
                    <Field label="开始时间" value={it.start || ""} onChange={(v) => patchContent((c) => (c.projects.find((x: any) => x.id === it.id)!.start = v))} />
                    <Field label="结束时间" value={it.end || ""} onChange={(v) => patchContent((c) => (c.projects.find((x: any) => x.id === it.id)!.end = v))} />
                    <Field label="项目链接" value={it.link || ""} onChange={(v) => patchContent((c) => (c.projects.find((x: any) => x.id === it.id)!.link = v))} />
                    <div className="col-span-2">
                      <Field label="项目描述" multiline value={it.description || ""} onChange={(v) => patchContent((c) => (c.projects.find((x: any) => x.id === it.id)!.description = v))} />
                    </div>
                  </div>
                )}
              />

              <CardView
                title="技能"
                items={content.skills}
                addLabel="添加技能组"
                onAdd={() => patchContent((c) => c.skills.push({ id: `s${Date.now()}`, category: "", items: "" }))}
                onRemove={(id) => patchContent((c) => (c.skills = c.skills.filter((x: any) => x.id !== id)))}
                renderFields={(it) => (
                  <div className="grid grid-cols-2 gap-3 pr-7">
                    <Field label="分类" value={it.category || ""} onChange={(v) => patchContent((c) => (c.skills.find((x: any) => x.id === it.id)!.category = v))} />
                    <Field label="技能（逗号分隔）" value={it.items || ""} onChange={(v) => patchContent((c) => (c.skills.find((x: any) => x.id === it.id)!.items = v))} />
                  </div>
                )}
              />
            </div>

            <div className="p-4 border-t border-slate-100 flex items-center gap-3">
              {err && <span className="text-sm text-red-500 flex-1">{err}</span>}
              <span className="flex-1" />
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-100 text-slate-600 text-sm hover:bg-slate-200">
                取消
              </button>
              <button onClick={onSave} disabled={saving} className={BTN_PRIMARY}>
                {saving && <Loader2 size={14} className="inline animate-spin mr-1" />}
                另存为新简历
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

const BASIC_FIELDS: { key: string; label: string; multiline?: boolean }[] = [
  { key: "name", label: "姓名" },
  { key: "title", label: "求职意向" },
  { key: "phone", label: "手机号" },
  { key: "email", label: "邮箱" },
  { key: "location", label: "城市" },
  { key: "website", label: "个人主页" },
  { key: "birthday", label: "出生年月" },
  { key: "gender", label: "性别" },
  { key: "currentStatus", label: "当前状态" },
  { key: "expectedSalary", label: "期望薪资" },
  { key: "workYears", label: "工作年限" },
  { key: "summary", label: "个人简介", multiline: true },
];