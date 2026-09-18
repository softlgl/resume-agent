import { useState, useEffect, useCallback } from "react";
import { Sparkles, X, AlertTriangle, AlertCircle, Lightbulb, TrendingUp, Brain, RefreshCw, Settings, Check, ChevronDown, ChevronUp, CornerDownRight, Braces } from "lucide-react";
import { api } from "../api/client";

// 前端 Issue 类型（和后端对齐）
interface Issue {
  severity: "error" | "warning" | "tip";
  field: string;
  problem: string;
  suggestion?: string;
  rewrite?: string;
  applied?: boolean;
}

interface AbilityProfile {
  tech: number;
  project: number;
  stability: number;
  communication: number;
  education: number;
}

interface MatchResult {
  score: number;
  mustHaves: { skill: string; matched: boolean }[];
  gaps: string[];
}

interface Analysis {
  atsScore: number;
  qualityScore?: number;
  sections: {
    basic: Issue[];
    works: Issue[];
    projects: Issue[];
    skills: Issue[];
  };
  summary?: {
    overall: string;
    strengths: string[];
    weaknesses: string[];
    priority: string;
  };
  abilityProfile?: AbilityProfile;
  match?: MatchResult;
  llmUsed: boolean;
  llmProvider?: string;
  reasoning?: string;
  output?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  content: any;
  resumeId: string | null;
  onApply?: (field: string, rewrite: string) => void;
  onGoto?: (field: string) => void; // 点击字段定位 → 跳转编辑器对应 section
}

// ---------------------------------------------------------------------------
// 分析结果缓存：已持久化到数据库（Resume.analysis 字段）
// 面板打开时调用 /ai/analyze，后端无 JD 场景会命中 DB 缓存直接返回
// （不重复消耗 LLM）；点右上角「重新分析」带 force=true 强制重生成并覆盖。
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<string, string> = {
  basic: "基本信息",
  works: "工作经历",
  educations: "教育经历",
  projects: "项目经历",
  skills: "技能",
};

// 字段中文名映射：works[0].end → 「工作经历·第 1 条·结束时间」
const FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  title: "求职意向",
  phone: "手机号",
  email: "邮箱",
  city: "所在城市",
  expectedSalary: "期望薪资",
  workYears: "工作年限",
  summary: "个人简介",
  avatar: "头像",
  company: "公司名称",
  role: "职位",
  start: "开始时间",
  end: "结束时间",
  current: "是否至今",
  description: "描述",
  school: "学校",
  major: "专业",
  degree: "学历",
  nameProject: "项目名称",
  link: "项目链接",
};

// 把 JSON 路径转成中文可读定位文本
function fieldToLabel(field: string): string {
  if (!field) return "";
  // 优先取顶层 section 名
  const top = field.split(/[.\[\]]+/)[0];
  const section = SECTION_LABELS[top] || top;
  // 取出数组索引，如 works[0] → 第1条
  const m = field.match(/\[(\d+)\]/);
  const idxPart = m ? `· 第${Number(m[1]) + 1}条` : "";
  // 取出末尾字段名
  const tokens = field.split(/[.\[\]]+/).filter(Boolean);
  const lastKey = tokens[tokens.length - 1];
  const fieldName = FIELD_LABELS[lastKey] || lastKey;
  return `${section}${idxPart} · ${fieldName}`;
}

function ScoreCard({ label, score, color }: { label: string; score: number; color: string }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex-1 bg-white rounded-xl p-3 shadow-sm border border-slate-100">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold" style={{ color }}>{pct}</span>
        <span className="text-xs text-slate-400">/ 100</span>
      </div>
      <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function FieldLink({ field, onGoto }: { field: string; onGoto?: (f: string) => void }) {
  return (
    <button
      onClick={() => onGoto?.(field)}
      className="inline-flex items-center gap-0.5 mx-0.5 px-1.5 py-[1px] rounded bg-brand-50 text-brand-700 text-xs font-medium border border-brand-200 whitespace-nowrap hover:bg-brand-100"
      title={`点击定位到${fieldToLabel(field)}`}
    >
      <CornerDownRight size={11} />
      {fieldToLabel(field)}
    </button>
  );
}

// 把文本中的字段路径（如 projects[0].link）转换成语义化、可点击定位的中文 chips
function RichText({ text, onGoto }: { text: string; onGoto?: (f: string) => void }) {
  if (!text) return null;
  const parts = text.split(/(\b(?:basic|works|projects|educations|skills)\[\d+\](?:\.[a-zA-Z0-9_]+)*\b)/g);
  return (
    <span>
      {parts.map((p, i) => {
        if (/^(?:basic|works|projects|educations|skills)\[\d+\]/.test(p)) {
          return <FieldLink key={i} field={p} onGoto={onGoto} />;
        }
        return <span key={i}>{p}</span>;
      })}
    </span>
  );
}

function SeverityIcon({ severity }: { severity: Issue["severity"] }) {
  if (severity === "error") return <AlertCircle size={14} className="text-red-500 shrink-0 mt-0.5" />;
  if (severity === "warning") return <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />;
  return <Lightbulb size={14} className="text-sky-500 shrink-0 mt-0.5" />;
}

function IssueList({ issues, section, onApply, onApplied, onGoto }: { issues: Issue[]; section: string; onApply?: (field: string, rewrite: string) => void; onApplied?: (section: string, index: number) => void; onGoto?: (field: string) => void }) {
  if (issues.length === 0) return <div className="text-xs text-slate-400">✓ 没有明显问题</div>;
  const [appliedIdx, setAppliedIdx] = useState<Set<number>>(new Set());
  return (
    <ul className="space-y-2">
      {issues.map((it, i) => {
        const applied = appliedIdx.has(i) || it.applied === true;
        return (
          <li key={i} className={`rounded-lg border p-2.5 text-sm transition ${applied ? "border-emerald-200 bg-emerald-50/60" : "border-slate-100 bg-white"}`}>
            <div className="flex gap-2">
              <SeverityIcon severity={it.severity} />
              <div className="flex-1 min-w-0">
                <div className="text-slate-700">{it.problem}</div>
                {it.suggestion && (
                  <div className="text-xs text-slate-500 mt-0.5">💡 {it.suggestion}</div>
                )}
                {it.field && (
                  <button
                    onClick={() => onGoto?.(it.field)}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 bg-brand-50 hover:bg-brand-100 px-1.5 py-0.5 rounded transition group"
                    title={`定位到编辑器：${it.field}`}
                  >
                    <CornerDownRight size={10} className="shrink-0" />
                    <span>{fieldToLabel(it.field)}</span>
                    <span className="text-brand-300 group-hover:text-brand-500 font-mono lowercase">跳到编辑</span>
                  </button>
                )}
                {/* AI 改写预览 + 应用按钮 */}
                {it.rewrite && !applied && (
                  <div className="mt-2 border-l-2 border-brand-400 bg-brand-50/50 rounded px-2.5 py-2">
                    <div className="text-[11px] text-brand-600 font-medium mb-1">✨ AI 改写建议</div>
                    <div className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">{it.rewrite}</div>
                    <button
                      onClick={() => { onApply?.(it.field, it.rewrite!); setAppliedIdx((s) => new Set(s).add(i)); onApplied?.(section, i); }}
                      className="mt-1.5 inline-flex items-center gap-1 text-[11px] bg-brand-600 text-white px-2.5 py-1 rounded hover:bg-brand-700 transition"
                    >
                      <Check size={12} /> 应用到简历
                    </button>
                  </div>
                )}
                {applied && (
                  <div className="mt-1.5 text-[11px] text-emerald-600 inline-flex items-center gap-1">
                    <Check size={12} /> 已应用
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// 纯 SVG 雷达图：固定尺寸、三层错开、无重叠
function RadarChart({ data }: { data: AbilityProfile }) {
  const axes: { key: keyof AbilityProfile; label: string; angle: number }[] = [
    { key: "tech", label: "技术能力", angle: -Math.PI / 2 },
    { key: "project", label: "项目复杂度", angle: -Math.PI / 2 + (Math.PI * 2) / 5 },
    { key: "stability", label: "稳定性", angle: -Math.PI / 2 + (Math.PI * 4) / 5 },
    { key: "communication", label: "沟通能力", angle: -Math.PI / 2 + (Math.PI * 6) / 5 },
    { key: "education", label: "教育背景", angle: -Math.PI / 2 + (Math.PI * 8) / 5 },
  ];
  const cx = 140, cy = 140;
  const R = 80; // 外圈半径

  // 每个轴的数据点、数值标签位置、文字标签位置预先算好
  const items = axes.map(({ key, label, angle }) => {
    const value = Math.max(0, Math.min(100, data[key]));
    const d = (value / 100) * R;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return {
      key, label, value, angle, cos, sin,
      // 数据点（圆点）在实际数值位置
      dotX: cx + cos * d,
      dotY: cy + sin * d,
      // 数值标签：沿轴线远离中心再偏 14px
      numX: cx + cos * (d + 14),
      numY: cy + sin * (d + 14),
      // 文字标签：最外圈再偏 28px
      lblX: cx + cos * (R + 28),
      lblY: cy + sin * (R + 28),
    };
  });

  const polygon = items.map((i) => `${i.dotX},${i.dotY}`).join(" ");

  // 网格（4 层）
  const gridLevels = [0.25, 0.5, 0.75, 1].map((lv) =>
    axes.map(({ angle }) => `${cx + Math.cos(angle) * R * lv},${cy + Math.sin(angle) * R * lv}`).join(" ")
  );

  // 外圈轴顶点
  const outerPts = axes.map(({ angle }) => ({
    x: cx + Math.cos(angle) * R,
    y: cy + Math.sin(angle) * R,
  }));

  return (
    // 固定 max-width 280，不撑满面板；viewBox 320 留够外圈空间
    <svg viewBox="0 0 320 320" className="block mx-auto max-w-[280px]">
      <defs>
        <linearGradient id="radarFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#a855f7" stopOpacity="0.15" />
        </linearGradient>
        <linearGradient id="radarStroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      {/* 网格多边形（4 层，逐层浓度递增） */}
      {gridLevels.map((poly, i) => (
        <polygon
          key={i}
          points={poly}
          fill="none"
          stroke={i === gridLevels.length - 1 ? "#c7d2fe" : "#e2e8f0"}
          strokeWidth={i === gridLevels.length - 1 ? 1.5 : 1}
        />
      ))}
      {/* 轴线 */}
      {outerPts.map((p, i) => (
        <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#e2e8f0" strokeWidth={1} />
      ))}
      {/* 数据区域（渐变填充 + 渐变描边） */}
      <polygon points={polygon} fill="url(#radarFill)" stroke="url(#radarStroke)" strokeWidth={2} strokeLinejoin="round" />
      {/* 外圈顶点装饰小圆点 */}
      {outerPts.map((p, i) => (
        <circle key={`v${i}`} cx={p.x} cy={p.y} r={2.5} fill="#e0e7ff" stroke="#6366f1" strokeWidth={1} />
      ))}
      {/* 数据点圆点（白描边 + 渐变中心实心） */}
      {items.map((i) => (
        <circle key={`d${i.key}`} cx={i.dotX} cy={i.dotY} r={4.5} fill="#6366f1" stroke="white" strokeWidth={1.5} />
      ))}

      {/* 数值标签（沿轴线外移 14px，白底矩形） */}
      {items.map((i) => {
        const text = String(i.value);
        const tw = text.length * 5;
        // 让文字以 numX,numY 为中心，矩形包裹它
        return (
          <g key={`n${i.key}`}>
            <rect
              x={i.numX - tw - 3}
              y={i.numY - 7}
              width={tw + 6}
              height={14}
              fill="white"
              rx={3}
              stroke="rgba(99,102,241,0.35)"
              strokeWidth={0.5}
            />
            <text
              x={i.numX}
              y={i.numY}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="11"
              fill="#4338ca"
              fontWeight="700"
            >
              {text}
            </text>
          </g>
        );
      })}

      {/* 文字标签（最外圈，左右两侧靠边对齐防溢出） */}
      {items.map((i) => {
        const anchor = i.cos > 0.2 ? "start" : i.cos < -0.2 ? "end" : "middle";
        return (
          <g key={`l${i.key}`}>
            <text
              x={i.lblX}
              y={i.lblY}
              textAnchor={anchor}
              dominantBaseline="middle"
              fontSize="12"
              fill="#334155"
              fontWeight="500"
            >
              {i.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function AIAnalysisPanel({ open, onClose, content, resumeId, onApply, onGoto }: Props) {
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState("");
  const [outText, setOutText] = useState("");
  const [jd, setJd] = useState("");
  const [analyzeWithJd, setAnalyzeWithJd] = useState(false);
  const [llmAvailable, setLlmAvailable] = useState<boolean | null>(null);

  // LLM 设置（可折叠）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llmProvider, setLlmProvider] = useState<string>("ollama");
  const [llmBaseUrl, setLlmBaseUrl] = useState("http://localhost:11434/v1");
  const [llmModel, setLlmModel] = useState("qwen3.5:4b");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmStatus, setLlmStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  // 打开面板时拉一次后端当前配置作为初始值
  useEffect(() => {
    if (open) {
      api.aiHealth().then((r) => setLlmAvailable(r.llmAvailable)).catch(() => {});
      api.aiGetConfig().then((cfg) => {
        if (cfg?.provider) setLlmProvider(cfg.provider);
        if (cfg?.baseUrl) setLlmBaseUrl(cfg.baseUrl);
        if (cfg?.model) setLlmModel(cfg.model);
      }).catch(() => {});
    }
  }, [open]);

  const handleSaveSettings = async () => {
    setLlmStatus("saving");
    try {
      const res = await api.aiSetConfig({
        provider: llmProvider as any,
        baseUrl: llmBaseUrl,
        model: llmModel,
        apiKey: llmApiKey,
      });
      if (res?.available) {
        setLlmStatus("saved");
        setTimeout(() => setLlmStatus("idle"), 1500);
      } else {
        setLlmStatus("failed");
      }
    } catch {
      setLlmStatus("failed");
    }
  };

  const handleResetSettings = async () => {
    try {
      const res = await api.aiResetConfig();
      if (res?.config) {
        setLlmProvider(res.config.provider);
        setLlmBaseUrl(res.config.baseUrl);
        setLlmModel(res.config.model);
      }
      setLlmApiKey("");
      setLlmStatus("saved");
      setTimeout(() => setLlmStatus("idle"), 1500);
    } catch {}
  };

  useEffect(() => {
    if (open) {
      setError(null);
      // 打开面板即调分析接口；后端会优先返回该简历已落库的缓存结果
      runAnalyze(false, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runAnalyze = async (withJd: boolean, force = true) => {
    setLoading(true);
    setError(null);
    setReasoning("");
    setOutText("");
    setAnalyzeWithJd(withJd);
    try {
      const res = await api.analyzeResumeStream(
        {
          content,
          resumeId: resumeId ?? undefined,
          jd: withJd ? jd.trim() : undefined,
          force,
        },
        (d) => setReasoning((prev) => prev + d),
        (d) => setOutText((prev) => prev + d)
      );
      setAnalysis(res.analysis);
      // 缓存命中时无流式，用落库的 reasoning/output 回填（否则填空不影响已流式累积的内容）
      if (res.analysis?.reasoning) setReasoning(res.analysis.reasoning);
      if (res.analysis?.output) setOutText(res.analysis.output);
    } catch (err: any) {
      setError(err.message || "分析失败");
    } finally {
      setLoading(false);
    }
  };

  // 标记某条建议为「已应用」：本地乐观更新 + 落库到 Resume.analysis（无 resumeId 的未保存简历仅本地标记）
  const markApplied = useCallback((section: string, index: number) => {
    setAnalysis((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      const list = next.sections?.[section as keyof typeof next.sections];
      if (list?.[index]) list[index].applied = true;
      return next;
    });
    if (resumeId) api.markIssueApplied(resumeId, section, index).catch(() => {});
  }, [resumeId]);

  if (!open) return null;

  const allIssues = analysis
    ? [...analysis.sections.basic, ...analysis.sections.works, ...analysis.sections.projects, ...analysis.sections.skills]
    : [];
  const errorCount = allIssues.filter((i) => i.severity === "error").length;
  const warningCount = allIssues.filter((i) => i.severity === "warning").length;
  const tipCount = allIssues.filter((i) => i.severity === "tip").length;

  return (
    <div className="fixed inset-0 z-30" aria-modal="true" role="dialog">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      {/* 抽屉 */}
      <div className="absolute right-0 top-0 h-full w-[520px] max-w-full bg-white shadow-2xl flex flex-col animate-[slideIn_.2s_ease-out]">
        {/* 头部 */}
        <div className="shrink-0">
          <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-brand-600" />
              <span className="font-semibold text-slate-800">AI 简历分析</span>
              {analysis && !analysis.llmUsed && (
                <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">仅硬规则</span>
              )}
              {analysis?.llmUsed && (
                <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                  {analysis.llmProvider}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                title="LLM 设置"
                className={`p-1.5 rounded-lg transition ${settingsOpen ? "text-brand-600 bg-brand-50" : "text-slate-500 hover:text-brand-600 hover:bg-slate-100"}`}
              >
                <Settings size={16} />
              </button>
              <button
                onClick={() => runAnalyze(false)}
                disabled={loading}
                title="重新分析"
                className="p-1.5 rounded-lg text-slate-500 hover:text-brand-600 hover:bg-slate-100 transition disabled:opacity-40"
              >
                <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              </button>
              <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition">
                <X size={18} />
              </button>
            </div>
          </div>

          {/* LLM 设置折叠区 */}
          {settingsOpen && (
            <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/60 space-y-2.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>LLM 模型配置</span>
                <button
                  onClick={handleResetSettings}
                  className="text-slate-400 hover:text-slate-600 transition"
                >
                  重置为 .env
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-500">
                  Provider
                  <select
                    value={llmProvider}
                    onChange={(e) => setLlmProvider(e.target.value)}
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
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
                    placeholder="如 qwen3.5:4b"
                  />
                </label>
              </div>
              <label className="text-xs text-slate-500">
                Base URL
                <input
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
                  placeholder="http://localhost:11434/v1"
                />
              </label>
              {!["ollama", "lmstudio", "vllm"].includes(llmProvider) && (
                <label className="text-xs text-slate-500">
                  API Key
                  <input
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm"
                    placeholder="sk-..."
                  />
                </label>
              )}
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleSaveSettings}
                  disabled={llmStatus === "saving"}
                  className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-brand-600 text-white text-sm py-1.5 hover:bg-brand-700 transition disabled:opacity-60"
                >
                  {llmStatus === "saving" && "保存中..."}
                  {llmStatus === "saved" && <><Check size={14} /> 已保存</>}
                  {llmStatus === "failed" && "保存失败"}
                  {llmStatus === "idle" && "保存并生效"}
                </button>
                <button
                  onClick={async () => { await handleSaveSettings(); runAnalyze(false); }}
                  className="rounded-md border border-slate-200 text-slate-600 text-sm py-1.5 px-3 hover:bg-white transition"
                >
                  保存并分析
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-20 text-slate-400">
              <div className="w-10 h-10 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mb-3" />
              <span className="text-sm">
                {analyzeWithJd ? "正在匹配岗位…" : "AI 正在分析…"}
              </span>
            </div>
          )}

          {error && !loading && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
          )}

          {/* AI 思考过程（推理模型才有；非推理模型不渲染） */}
          {reasoning && (
            <details className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden group">
              <summary className="flex items-center gap-1.5 px-3 py-2.5 cursor-pointer select-none text-sm text-slate-600 hover:bg-slate-100">
                <Brain size={14} className="text-slate-400 shrink-0" />
                <span className="font-medium">AI 思考过程</span>
                <span className="text-xs text-slate-400 ml-auto">{loading ? "思考中…" : `${reasoning.length} 字`}</span>
              </summary>
              <pre className="px-3 pb-3 text-xs leading-relaxed text-slate-500 whitespace-pre-wrap max-h-64 overflow-y-auto">
                {reasoning}
              </pre>
            </details>
          )}

          {/* AI 输出内容（模型的原始 JSON 全文；推理模型完成前逐字累积，结束后格式化） */}
          {outText && (
            <details className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden" open={!loading}>
              <summary className="flex items-center gap-1.5 px-3 py-2.5 cursor-pointer select-none text-sm text-slate-600 hover:bg-slate-100">
                <Braces size={14} className="text-slate-400 shrink-0" />
                <span className="font-medium">AI 输出内容</span>
                <span className="text-xs text-slate-400 ml-auto">{loading ? "生成中…" : "原始 JSON"}</span>
              </summary>
              <pre className="px-3 pb-3 text-xs leading-relaxed text-slate-600 whitespace-pre-wrap max-h-64 overflow-y-auto">
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

          {/* 前置：未配置 AI 模型提示（分析前） */}
          {llmAvailable === false && !analysis && !loading && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>未配置 AI 模型，当前仅进行本地硬规则检查（无评分总结、能力画像与问题改写）。点右上角齿轮配置 LLM 后即可启用 AI 分析。</span>
            </div>
          )}

          {analysis && !loading && (
            <>
              {/* 分数卡 */}
              <div className="flex gap-3">
                <ScoreCard label="ATS 友好度" score={analysis.atsScore} color="#3b82f6" />
                {analysis.qualityScore !== undefined ? (
                  <ScoreCard label="内容质量" score={analysis.qualityScore} color="#10b981" />
                ) : (
                  <div className="flex-1 bg-white rounded-xl p-3 shadow-sm border border-dashed border-slate-200 text-center">
                    <div className="text-xs text-slate-400">内容质量（需 AI）</div>
                    <div className="text-xs text-slate-300 mt-1">未分析</div>
                  </div>
                )}
              </div>

              {/* 结构化总结（方案 B） */}
              {analysis.summary && (
                <div className="bg-white rounded-xl border border-brand-100 shadow-sm overflow-hidden">
                  <div className="flex items-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-brand-50 to-violet-50 border-b border-brand-100">
                    <Sparkles size={14} className="text-brand-600" />
                    <span className="text-sm font-semibold text-slate-700">AI 总结</span>
                  </div>
                  <div className="p-4 space-y-3 text-sm">
                    <p className="text-slate-700 leading-relaxed">{analysis.summary.overall}</p>
                    {analysis.summary.strengths.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-emerald-600 mb-1.5">✓ 核心优势</div>
                        <ul className="space-y-1">
                          {analysis.summary.strengths.slice(0, 4).map((s, i) => (
                            <li key={i} className="flex gap-1.5 text-slate-600">
                              <span className="text-emerald-500">•</span>{s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.summary.weaknesses.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-rose-600 mb-1.5">✗ 核心短板</div>
                        <ul className="space-y-1">
                          {analysis.summary.weaknesses.slice(0, 4).map((s, i) => (
                            <li key={i} className="flex gap-1.5 text-slate-600">
                              <span className="text-rose-500">•</span>{s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.summary.priority && (
                      <div className="pt-2 border-t border-slate-100">
                        <div className="flex gap-1.5">
                          <span className="text-xs font-medium text-brand-600 shrink-0 mt-0.5">▸ 优先行动</span>
                          <span className="text-slate-700 leading-relaxed"><RichText text={analysis.summary.priority} onGoto={onGoto} /></span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 能力雷达图 */}
              <div className="bg-slate-50 rounded-xl p-5">
                <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1">
                  <Brain size={14} className="text-brand-600" />
                  能力画像
                </div>
                {analysis.abilityProfile ? (
                  <RadarChart data={analysis.abilityProfile} />
                ) : (
                  <div className="flex flex-col items-center justify-center h-[200px] text-slate-400">
                    <Brain size={28} className="opacity-30 mb-2" />
                    <div className="text-xs">能力画像需启用 AI 分析</div>
                  </div>
                )}
              </div>

              {/* 问题统计 */}
              <div className="flex gap-3 text-xs">
                <span className="flex items-center gap-1">
                  <AlertCircle size={13} className="text-red-500" />
                  错误 {errorCount}
                </span>
                <span className="flex items-center gap-1">
                  <AlertTriangle size={13} className="text-amber-500" />
                  警告 {warningCount}
                </span>
                <span className="flex items-center gap-1">
                  <Lightbulb size={13} className="text-sky-500" />
                  建议 {tipCount}
                </span>
              </div>

              {/* 分模块问题 */}
              {(["basic", "works", "projects", "skills"] as const).map((section) => {
                const issues = analysis.sections[section];
                if (issues.length === 0) return null;
                return (
                  <div key={section} className="bg-white rounded-xl border border-slate-100 p-3">
                    <div className="text-sm font-medium text-slate-700 mb-2">
                      {SECTION_LABELS[section]}
                    </div>
                    <IssueList issues={issues} section={section} onApply={onApply} onApplied={markApplied} onGoto={onGoto} />
                  </div>
                );
              })}

              {/* JD 匹配结果 */}
              {analysis.match && (
                <div className="bg-white rounded-xl border border-slate-100 p-3">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-2">
                    <TrendingUp size={14} className="text-brand-600" />
                    岗位匹配度：{analysis.match.score} 分
                  </div>
                  {analysis.match.mustHaves.length > 0 && (
                    <div className="mb-2">
                      <div className="text-xs text-slate-500 mb-1">硬性要求</div>
                      <div className="flex flex-wrap gap-1.5">
                        {analysis.match.mustHaves.map((h, i) => (
                          <span
                            key={i}
                            className={`text-xs px-2 py-0.5 rounded ${
                              h.matched ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                            }`}
                          >
                            {h.matched ? "✓" : "✗"} {h.skill}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {analysis.match.gaps.length > 0 && (
                    <div>
                      <div className="text-xs text-slate-500 mb-1">差距项</div>
                      <ul className="text-xs text-slate-700 space-y-0.5">
                        {analysis.match.gaps.map((g, i) => (
                          <li key={i}>• {g}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* JD 输入框（始终可见，支持重复匹配） */}
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-sm font-medium text-slate-700 mb-2">🎯 贴 JD 做岗位匹配（可选）</div>
                <textarea
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
                  rows={4}
                  placeholder="粘贴目标岗位的职位描述，AI 会分析匹配度和差距"
                  value={jd}
                  onChange={(e) => setJd(e.target.value)}
                />
                <button
                  onClick={() => runAnalyze(true)}
                  disabled={loading || !jd.trim()}
                  className="mt-2 w-full text-sm py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition"
                >
                  {loading ? "分析中…" : "重新分析 + 匹配岗位"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
