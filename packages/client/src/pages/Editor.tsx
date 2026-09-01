import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useResumeStore } from "../store/resume";
import { api, getToken } from "../api/client";
import Preview from "../components/Preview";
import TemplatePicker from "../components/TemplatePicker";
import SectionForm from "../components/SectionForm";
import ResumeSwitcher from "../components/ResumeSwitcher";
import { FileDown, Save, Check, LogOut, LayoutTemplate } from "lucide-react";
import type { WorkExp, EduExp, ProjectExp, SkillGroup } from "@resume-agent/shared";

export default function Editor() {
  const { id, title, templateId, content, setField, setTitle, setTemplate, load, loadResume, loadList, toInput, markSaved } =
    useResumeStore();
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<"docx" | "pdf" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewPages, setPreviewPages] = useState(1);
  const exportRef = useRef<HTMLDivElement>(null);
  const previewAreaRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const urlId = params.id;

  const basic = content.basic;

  // 从 URL :id 加载指定简历（每次 urlId 变化都加载，保证 content 正确；store.id 持久化但 content 不持久化，刷新后需重新加载）
  useEffect(() => {
    if (urlId) {
      loadResume(urlId).then((ok) => {
        if (!ok) navigate("/editor", { replace: true });
      });
    } else if (id) {
      // URL 无 id 但 store 有：跳到带 id 的 URL
      navigate(`/editor/${id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlId]);

  // 顺便刷新一下列表（让 switcher 显示最新）
  useEffect(() => {
    if (id) loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 点击菜单外部时关闭导出浮窗
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // 让预览 A4 纸（210mm≈793.7px）等比缩放适配预览区宽度，保证与导出 PDF 视觉比例一致
  useEffect(() => {
    const area = previewAreaRef.current;
    if (!area) return;
    const compute = () => {
      const avail = area.clientWidth - 32; // 减去内边距
      const scale = Math.min(1, avail / 793.7);
      setPreviewScale(scale);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  // Preview 通过回调上报当前页数，用于撑开预览占位高度（避免多页被截断）
  const handlePagesChange = useCallback((n: number) => setPreviewPages(n), []);

  const save = async (silent = false) => {
    setSaving(true);
    try {
      const input = toInput();
      if (id) {
        await api.updateResume(id, input);
      } else {
        const res = await api.createResume(input);
        const newId: string = res.resume.id;
        load({ id: newId, title, templateId, content });
        // 新建后跳到带 id 的 URL，并刷新列表让 switcher 显示
        navigate(`/editor/${newId}`, { replace: true });
        loadList();
      }
      markSaved();
      if (!silent) {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1500);
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  };

  const doExport = async (format: "docx" | "pdf") => {
    if (!id) {
      alert("请先保存简历再导出");
      return;
    }
    setMenuOpen(false);
    setExporting(format);
    try {
      // 导出前先保存，确保当前选中的模板与内容已写入后端
      await save(true);
      const token = getToken();
      const res = await fetch(api.exportUrl(id, format), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `导出失败 (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title || "resume"}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setExporting(null);
    }
  };

  const logout = () => {
    localStorage.removeItem("resume_agent_token");
    navigate("/login");
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶部导航 */}
      <header className="fixed top-0 left-0 right-0 z-10 glass">
        <div className="flex items-center justify-between px-5 h-16">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-xl font-bold text-brand-700 shrink-0">简历助手</span>
            <ResumeSwitcher />
            <input
              className="bg-transparent border-b border-transparent hover:border-slate-300 focus:border-brand-500 outline-none text-sm px-1 py-0.5 w-40"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="简历标题"
            />
          </div>
          <div className="flex items-center gap-3">
            {savedFlash ? (
              <span className="flex items-center gap-1 text-green-600 text-sm">
                <Check size={16} /> 已保存
              </span>
            ) : (
              <span className="text-sm text-slate-400">{saving ? "保存中…" : "自动草稿已存"}</span>
            )}
            <button
              onClick={() => save()}
              disabled={saving}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-sm hover:bg-brand-700 transition disabled:opacity-60"
            >
              <Save size={15} /> 保存
            </button>
            <div className="relative" ref={exportRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                disabled={exporting !== null}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 text-white text-sm hover:bg-slate-900 transition disabled:opacity-60"
              >
                <FileDown size={15} /> {exporting ? "导出中…" : "导出"}
              </button>
              {menuOpen && (
                <div
                  className="absolute right-0 top-full pt-1 flex flex-col glass rounded-xl shadow-glass p-1 w-32 z-20"
                  onMouseLeave={() => setMenuOpen(false)}
                >
                  <button onClick={() => doExport("docx")} className="px-3 py-2 text-sm rounded-lg hover:bg-white/60 text-left">
                    Word (.docx)
                  </button>
                  <button onClick={() => doExport("pdf")} className="px-3 py-2 text-sm rounded-lg hover:bg-white/60 text-left">
                    PDF (.pdf)
                  </button>
                </div>
              )}
            </div>
            <button onClick={logout} className="text-slate-500 hover:text-red-500 transition" title="退出登录">
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* 主体：左编辑 右预览 */}
      <div className="flex pt-16 flex-1 h-[calc(100vh-4rem)]">
        <section className="w-1/2 overflow-y-auto px-5 py-5 space-y-4">
          {/* 基本信息 */}
          <div className="glass rounded-2xl p-4 shadow-glass">
            <h2 className="text-lg font-bold text-slate-800 mb-3">基本信息</h2>
            <div className="grid grid-cols-2 gap-2">
              {([
                ["name", "姓名"],
                ["title", "求职意向"],
                ["phone", "电话"],
                ["email", "邮箱"],
                ["location", "所在地"],
                ["website", "个人主页"],
              ] as const).map(([k, label]) => (
                <label key={k}>
                  <span className="text-xs text-slate-500">{label}</span>
                  <input
                    className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                    value={(basic as any)[k]}
                    onChange={(e) => setField("basic", { ...basic, [k]: e.target.value })}
                  />
                </label>
              ))}
              {/* 新增字段 */}
              <label>
                <span className="text-xs text-slate-500">出生年月</span>
                <input
                  type="month"
                  className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  value={basic.birthday}
                  onChange={(e) => setField("basic", { ...basic, birthday: e.target.value })}
                />
              </label>
              <label>
                <span className="text-xs text-slate-500">性别</span>
                <select
                  className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  value={basic.gender}
                  onChange={(e) => setField("basic", { ...basic, gender: e.target.value })}
                >
                  <option value="">未填写</option>
                  <option value="男">男</option>
                  <option value="女">女</option>
                </select>
              </label>
              <label>
                <span className="text-xs text-slate-500">当前状态</span>
                <select
                  className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  value={basic.currentStatus}
                  onChange={(e) => setField("basic", { ...basic, currentStatus: e.target.value })}
                >
                  <option value="">未填写</option>
                  <option value="在职">在职</option>
                  <option value="离职">离职</option>
                  <option value="应届">应届</option>
                </select>
              </label>
              <label>
                <span className="text-xs text-slate-500">期望薪资</span>
                <input
                  className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="如 15k-20k"
                  value={basic.expectedSalary}
                  onChange={(e) => setField("basic", { ...basic, expectedSalary: e.target.value })}
                />
              </label>
              <label className="col-span-2">
                <span className="text-xs text-slate-500">工作年限</span>
                <input
                  className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                  placeholder="如 3 年"
                  value={basic.workYears}
                  onChange={(e) => setField("basic", { ...basic, workYears: e.target.value })}
                />
              </label>
              <label className="col-span-2">
                <span className="text-xs text-slate-500">个人简介</span>
                <textarea
                  className="w-full mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500"
                  rows={3}
                  value={basic.summary}
                  onChange={(e) => setField("basic", { ...basic, summary: e.target.value })}
                />
              </label>
            </div>
          </div>

          <SectionForm<WorkExp>
            title="工作经历"
            items={content.works}
            empty={() => ({ id: "", company: "", role: "", start: "", end: "", current: false, description: "" })}
            onChange={(v) => setField("works", v)}
            fields={[
              { key: "company", label: "公司" },
              { key: "role", label: "职位" },
              { key: "start", label: "开始时间", type: "month" },
              { key: "end", label: "结束时间", type: "month" },
              { key: "current", label: "至今", type: "checkbox" },
              { key: "description", label: "描述（每行一条）", type: "textarea" },
            ]}
          />
          <SectionForm<EduExp>
            title="教育经历"
            items={content.educations}
            empty={() => ({ id: "", school: "", major: "", degree: "", start: "", end: "", description: "" })}
            onChange={(v) => setField("educations", v)}
            fields={[
              { key: "school", label: "学校" },
              { key: "major", label: "专业" },
              { key: "degree", label: "学历" },
              { key: "start", label: "开始时间", type: "month" },
              { key: "end", label: "结束时间", type: "month" },
              { key: "description", label: "描述", type: "textarea" },
            ]}
          />
          <SectionForm<ProjectExp>
            title="项目经历"
            items={content.projects}
            empty={() => ({ id: "", name: "", role: "", start: "", end: "", link: "", description: "" })}
            onChange={(v) => setField("projects", v)}
            fields={[
              { key: "name", label: "项目名称" },
              { key: "role", label: "角色" },
              { key: "start", label: "开始时间", type: "month" },
              { key: "end", label: "结束时间", type: "month" },
              { key: "link", label: "链接" },
              { key: "description", label: "描述（每行一条）", type: "textarea" },
            ]}
          />
          <SectionForm<SkillGroup>
            title="技能"
            items={content.skills}
            empty={() => ({ id: "", category: "", items: "" })}
            onChange={(v) => setField("skills", v)}
            fields={[
              { key: "category", label: "分类（如 前端）" },
              { key: "items", label: "技能（逗号或换行分隔）", type: "textarea" },
            ]}
          />
        </section>

        {/* 预览区 */}
        <section className="w-1/2 bg-slate-200/50 overflow-y-auto py-5 px-5">
          <div className="flex items-center gap-2 mb-3 text-slate-600">
            <LayoutTemplate size={16} />
            <span className="text-sm font-medium">模板选择</span>
          </div>
          <TemplatePicker value={templateId} onChange={setTemplate} />
          <div ref={previewAreaRef} className="mt-3 rounded-lg bg-slate-300/40 p-4 overflow-auto">
            {/* 占位层：按缩放后的 A4 实际尺寸占位（px），保证布局不塌陷 */}
            <div
              className="mx-auto relative"
              style={{ width: 793.7 * previewScale, height: (previewPages * 1122.5 + Math.max(0, previewPages - 1) * 30.2) * previewScale }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "793.7px",
                  transform: `scale(${previewScale})`,
                  transformOrigin: "top left",
                }}
              >
                <div style={{ width: "210mm" }}>
                  <Preview content={content} templateId={templateId} onPagesChange={handlePagesChange} />
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
