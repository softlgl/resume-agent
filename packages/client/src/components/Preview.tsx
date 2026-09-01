import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getTemplate, splitSkills, calcAge, soften, PRINT, splitBulletLines, type ResumeContent } from "@resume-agent/shared";

function lines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

// pt -> CSS pt（字号单位）
const pt = (v: number) => `${v}pt`;
// pt -> CSS px（间距单位；96dpi 下 1pt = 4/3 px，与浏览器测量高度口径一致）
const px = (p: number) => `${(p * 96) / 72}px`;
const mm = (p: number) => `${(p * 25.4) / 72}mm`;

// 中文字体栈：宋体族优先。PDF 用 STSONG.TTF（华文宋体），浏览器优先 SimSun，
// 同为宋体族 metric 接近，换行位置基本一致。
const FONT_STACK = "SimSun, STSong, 'Songti SC', serif";

// 间距令牌（pt 基准），与 PDF/DOCX 共用
const S = PRINT.spacing;

// A4 页内容区高度（mm）：297mm 减上下边距
const PAGE_CONTENT_MM = 297 - (PRINT.margin * 25.4) / 72 * 2;

function extraBasicLines(b: ResumeContent["basic"]): string[] {
  const out: string[] = [];
  const age = calcAge(b.birthday);
  if (b.birthday) out.push(`出生：${b.birthday}${age ? `（${age}岁）` : ""}`);
  if (b.gender) out.push(`性别：${b.gender}`);
  if (b.currentStatus) out.push(`状态：${b.currentStatus}`);
  if (b.expectedSalary) out.push(`期望薪资：${b.expectedSalary}`);
  if (b.workYears) out.push(`工作年限：${b.workYears}`);
  return out;
}

function sectionLabel(k: string): string {
  return (
    { summary: "个人简介", works: "工作经历", educations: "教育经历", projects: "项目经历", skills: "技能" } as Record<
      string,
      string
    >
  )[k];
}

export default function Preview({ content, templateId, onPagesChange }: { content: ResumeContent; templateId: string; onPagesChange?: (pages: number) => void }) {
  const tpl = getTemplate(templateId);
  const c = tpl.colors;
  const b = content.basic;
  const F = PRINT.fontSize;

  const single = tpl.layout !== "two-column";

  // 测量宽度（mm）：单栏=整页去左右边距；双栏=主区去左右边距
  const marginMm = (PRINT.margin * 25.4) / 72;
  const mainPct = 1 - PRINT.sidebarWidth / PRINT.page.width;
  const measureWidth = single
    ? `${210 - marginMm * 2}mm`
    : `${210 * mainPct - marginMm * 2}mm`;

  const renderSectionBlocks = (key: string) => {
    const blocks: React.ReactNode[] = [];
    const title = <SectionTitle key={key + "-t"} text={sectionLabel(key)} c={c} F={F} />;
    blocks.push(title);
    if (key === "summary" && b.summary)
      lines(b.summary).forEach((l, i) => blocks.push(<P key={key + i} c={c} F={F} size={F.body}>{l}</P>));
    else if (key === "works")
      content.works.forEach((w) =>
        blocks.push(
          <WorkBlock key={w.id} title={`${w.role} · ${w.company}`} right={`${w.start} - ${w.current ? "至今" : w.end}`} desc={splitBulletLines(w.description)} c={c} F={F} />
        )
      );
    else if (key === "educations")
      content.educations.forEach((e) =>
        blocks.push(
          <EduBlock key={e.id} title={`${e.school} · ${e.major} · ${e.degree}`} right={`${e.start} - ${e.end}`} desc={lines(e.description)} c={c} F={F} />
        )
      );
    else if (key === "projects")
      content.projects.forEach((p) =>
        blocks.push(
          <ProjectBlock key={p.id} p={p} c={c} F={F} />
        )
      );
    else if (key === "skills")
      content.skills.forEach((g) =>
        blocks.push(
          <div key={g.id} style={{ marginBottom: px(S.bodyAfter) }}>
            <span style={{ fontWeight: 700, fontSize: pt(F.body), color: c.text, lineHeight: S.lineHeight }}>{g.category}：</span>
            <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "4px", verticalAlign: "baseline" }}>
              {splitSkills(g.items).map((s, i) => (
                <span key={i} style={{ fontSize: pt(F.bullet), color: c.primary, background: soften(c.primary, 0.08), padding: `1px ${px(S.bulletAfter)}`, borderRadius: px(2), lineHeight: "1.4" }}>{s}</span>
              ))}
            </span>
          </div>
        )
      );
    return blocks;
  };

  // 单栏头部：作为独立块加入分页流，确保第一页留出 header 高度（与 PDF 一致）
  // 外层主色软底带（8% 透明混白），强化视觉锚点
  const headerBandBg = soften(c.primary, 0.08);
  const header = single ? (
    <div style={{ background: headerBandBg, margin: `0 ${px(-S.sectionBefore)} ${px(S.titleAfter)}`, padding: `${px(S.nameAfter)} ${px(S.sectionBefore)}`, borderRadius: px(2) }}>
      <h1 style={{ fontSize: pt(F.name), fontWeight: 700, color: c.primary, margin: 0, lineHeight: S.lineHeight }}>{b.name || "姓名"}</h1>
      {b.title && <p style={{ fontSize: pt(F.title), color: c.muted, margin: `${px(S.nameAfter)} 0 0`, lineHeight: S.lineHeight }}>{b.title}</p>}
      {[b.phone, b.email, b.location, b.website].filter(Boolean).length > 0 && (
        <p style={{ fontSize: pt(F.small), color: c.muted, margin: `${px(S.titleAfter)} 0 0`, lineHeight: S.lineHeight }}>
          {[b.phone, b.email, b.location, b.website].filter(Boolean).join("  |  ")}
        </p>
      )}
      {extraBasicLines(b).length > 0 && (
        <p style={{ fontSize: pt(F.small), color: c.muted, margin: `${px(S.contactAfter)} 0 0`, lineHeight: S.lineHeight }}>{extraBasicLines(b).join("  |  ")}</p>
      )}
    </div>
  ) : null;

  // 收集所有内容块（用于分页测量）
  const allBlocks: { key: string; block: React.ReactNode }[] = [];
  if (single && header) {
    allBlocks.push({ key: "header", block: header });
  }
  tpl.sectionOrder.forEach((k) => {
    renderSectionBlocks(k).forEach((blk, i) => allBlocks.push({ key: `${k}-${i}`, block: blk }));
  });

  // 分页状态：每个块高度（px），以及每页放哪些块
  const [blockHeights, setBlockHeights] = useState<number[]>([]);
  const [measured, setMeasured] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);

  // 测量每个块的高度
  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const nodes = measureRef.current.querySelectorAll<HTMLElement>("[data-block]");
    const heights: number[] = [];
    nodes.forEach((n) => heights.push(n.offsetHeight));
    setBlockHeights(heights);
    setMeasured(true);
  }, [content, templateId, allBlocks.length]);

  // 每页可用高度（px）——按 A4 内容区 mm 换算（96dpi）
  const contentHeightPx = (PAGE_CONTENT_MM / 25.4) * 96;

  // 贪心分页
  const pages: number[][] = [];
  if (measured && blockHeights.length === allBlocks.length) {
    let cur: number[] = [];
    let curH = 0;
    blockHeights.forEach((h, i) => {
      const hPx = h;
      if (cur.length > 0 && curH + hPx > contentHeightPx) {
        pages.push(cur);
        cur = [];
        curH = 0;
      }
      cur.push(i);
      curH += hPx;
    });
    if (cur.length) pages.push(cur);
  }

  // 通知父组件当前页数（用于撑开预览占位高度，避免多页被截断）
  useEffect(() => {
    onPagesChange?.(pages.length || 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length]);

  // 双栏侧栏内容（仅在首页渲染文字，与 PDF 一致：换页时只补画背景）
  const renderSidebar = (isFirst: boolean) => (
    <>
      <h1 style={{ fontSize: pt(F.sidebarName), fontWeight: 700, margin: 0, lineHeight: S.lineHeight }}>{b.name || "姓名"}</h1>
      {b.title && <p style={{ fontSize: pt(F.sidebarTitle), color: "#93C5FD", margin: `${px(S.sideNameAfter)} 0 0`, lineHeight: S.lineHeight }}>{b.title}</p>}
      <h4 style={{ fontSize: pt(F.sidebarLabel), fontWeight: 700, color: "#fff", margin: `${px(S.sideTitleAfter + S.sideLabelBefore)} 0 ${px(S.sideLabelAfter)}`, lineHeight: S.lineHeight }}>联系方式</h4>
      {b.phone && <p style={{ fontSize: pt(F.sidebarField), color: "#CBD5E1", margin: `0 0 ${px(S.sideFieldAfter)}`, lineHeight: S.lineHeight }}>电话：{b.phone}</p>}
      {b.email && <p style={{ fontSize: pt(F.sidebarField), color: "#CBD5E1", margin: `0 0 ${px(S.sideFieldAfter)}`, lineHeight: S.lineHeight }}>邮箱：{b.email}</p>}
      {b.location && <p style={{ fontSize: pt(F.sidebarField), color: "#CBD5E1", margin: `0 0 ${px(S.sideFieldAfter)}`, lineHeight: S.lineHeight }}>地址：{b.location}</p>}
      {b.website && <p style={{ fontSize: pt(F.sidebarField), color: "#CBD5E1", margin: `0 0 ${px(S.sideFieldAfter)}`, lineHeight: S.lineHeight }}>主页：{b.website}</p>}
      {extraBasicLines(b).map((l, i) => (
        <p key={i} style={{ fontSize: pt(F.sidebarField), color: "#CBD5E1", margin: `0 0 ${px(S.sideFieldAfter)}`, lineHeight: S.lineHeight }}>{l}</p>
      ))}
    </>
  );

  // 渲染单页内容
  const renderPage = (blockIdx: number[], isFirst: boolean) => {
    if (single) {
      return (
        <div style={{ width: "210mm", height: "297mm", background: "#fff", padding: mm(PRINT.margin), boxSizing: "border-box", fontFamily: FONT_STACK, overflow: "hidden" }}>
          {blockIdx.map((i) => allBlocks[i].block)}
        </div>
      );
    }
    // 双栏：侧栏背景每页都画，文字仅在首页画（与 PDF 换页行为一致）
    return (
      <div style={{ width: "210mm", height: "297mm", display: "flex", background: "#fff", fontFamily: FONT_STACK, overflow: "hidden" }}>
        <aside style={{ width: `${(PRINT.sidebarWidth / PRINT.page.width) * 100}%`, background: c.sidebar, color: "#fff", padding: mm(PRINT.margin), boxSizing: "border-box" }}>
          {isFirst && renderSidebar(true)}
        </aside>
        <main style={{ width: `${(1 - PRINT.sidebarWidth / PRINT.page.width) * 100}%`, background: "#fff", padding: mm(PRINT.margin), boxSizing: "border-box" }}>
          {blockIdx.map((i) => allBlocks[i].block)}
        </main>
      </div>
    );
  };

  return (
    <div>
      {/* 隐藏测量容器：渲染全部块，用于量高度（与真实渲染同宽） */}
      <div
        ref={measureRef}
        style={{ position: "absolute", visibility: "hidden", pointerEvents: "none", left: 0, top: 0, fontFamily: FONT_STACK }}
      >
        <div style={{ width: measureWidth }}>
          {allBlocks.map((x, i) => (
            <div key={x.key} data-block={i}>{x.block}</div>
          ))}
        </div>
      </div>

      {/* 渲染分页后的纸张 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8mm", alignItems: "center" }}>
        {!measured || blockHeights.length !== allBlocks.length ? (
          // 未测量完：渲染完整一页占位
          <div style={{ width: "210mm", minHeight: "297mm", background: "#fff", padding: mm(PRINT.margin), boxSizing: "border-box", fontFamily: FONT_STACK }}>
            {single && header}
            {allBlocks.filter((x) => x.key !== "header").map((x) => x.block)}
          </div>
        ) : (
          pages.map((blockIdx, pi) => (
            <div key={pi} style={{ boxShadow: "0 2px 12px rgba(0,0,0,0.15)" }}>
              {renderPage(blockIdx, pi === 0)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// 子组件（避免内联太多）——间距全部读取 PRINT.spacing，与 PDF/DOCX 对齐
// 章节标题：左侧 4pt 主色竖条 + 文字，下方横线（与 PDF/DOCX 一致）
function SectionTitle({ text, c, F }: { text: string; c: any; F: any }) {
  return (
    <h3 style={{ fontSize: pt(F.sectionTitle), fontWeight: 700, color: c.primary, borderBottom: `1px solid ${c.line}`, paddingBottom: px(S.lineGap), margin: `${px(S.sectionBefore)} 0 ${px(S.sectionAfter)}`, lineHeight: S.lineHeight, display: "flex", alignItems: "center", gap: px(S.bulletAfter) }}>
      <span style={{ display: "inline-block", width: px(S.bulletAfter), height: pt(F.sectionTitle), background: c.primary, borderRadius: px(1), flexShrink: 0 }} />
      {text}
    </h3>
  );
}
function P({ children, c, F, size, style }: any) {
  return <p style={{ fontSize: pt(size), color: c.text, marginBottom: px(S.bodyAfter), lineHeight: S.lineHeight, ...style }}>{children}</p>;
}
function WorkBlock({ title, right, desc, c, F }: any) {
  return (
    <div style={{ marginBottom: px(S.blockAfter), breakInside: "avoid" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, fontSize: pt(F.body * S.inlineTitleScale), color: c.text, lineHeight: S.lineHeight }}>{title}</span>
        <span style={{ fontSize: pt(F.small), color: c.muted, lineHeight: S.lineHeight }}>{right}</span>
      </div>
      {desc.map((l: string, i: number) => (
        <p key={i} style={{ fontSize: pt(F.bullet), marginLeft: 12, marginBottom: px(S.bulletAfter), color: c.text, lineHeight: S.lineHeight }}>- {l}</p>
      ))}
    </div>
  );
}
function EduBlock({ title, right, desc, c, F }: any) {
  return (
    <div style={{ marginBottom: px(S.blockAfter), breakInside: "avoid" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, fontSize: pt(F.body * S.inlineTitleScale), color: c.text, lineHeight: S.lineHeight }}>{title}</span>
        <span style={{ fontSize: pt(F.small), color: c.muted, lineHeight: S.lineHeight }}>{right}</span>
      </div>
      {desc.map((l: string, i: number) => (
        <p key={i} style={{ fontSize: pt(F.body), marginBottom: px(S.bulletAfter), color: c.text, lineHeight: S.lineHeight }}>{l}</p>
      ))}
    </div>
  );
}
function ProjectBlock({ p, c, F }: any) {
  return (
    <div style={{ marginBottom: px(S.blockAfter), breakInside: "avoid" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, fontSize: pt(F.body * S.inlineTitleScale), color: c.text, lineHeight: S.lineHeight }}>{p.name} · {p.role}</span>
        <span style={{ fontSize: pt(F.small), color: c.muted, lineHeight: S.lineHeight }}>{p.start} - {p.end}</span>
      </div>
      {p.link && <p style={{ fontSize: pt(F.small), marginBottom: px(S.bulletAfter), color: c.accent, lineHeight: S.lineHeight }}>{p.link}</p>}
      {splitBulletLines(p.description).map((l: string, i: number) => (
        <p key={i} style={{ fontSize: pt(F.bullet), marginLeft: 12, marginBottom: px(S.bulletAfter), color: c.text, lineHeight: S.lineHeight }}>- {l}</p>
      ))}
    </div>
  );
}
