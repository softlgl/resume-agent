import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  LevelFormat,
  BorderStyle,
  TabStopType,
  TabStopPosition,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  VerticalAlign,
  HeightRule,
  LineRuleType,
} from "docx";
import type { ResumeContent } from "@resume-agent/shared";
import { getTemplate, splitSkills, calcAge, soften, PRINT, splitBulletLines, type TemplateConfig } from "@resume-agent/shared";

function hex(c: string) {
  return c.replace("#", "");
}

function lines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

// 宋体（统一字体）：Word 中英文与中文都用 SimSun
const RUN_FONT = { ascii: "SimSun", hAnsi: "SimSun", eastAsia: "SimSun" } as const;

// 创建带宋体的 TextRun
function tr(props: any): TextRun {
  return new TextRun({ ...props, font: RUN_FONT });
}

// pt -> half-point（DOCX 的 size 单位）
const S = PRINT.docxSize;
// 间距令牌（pt 基准），与预览/PDF 共用；DOCX 按 twips = pt * 20 换算
const SP = PRINT.spacing;
// pt -> twips
const tw = (pt: number) => Math.round(pt * 20);
// 行距：1.5 倍 = 240 * 1.5 = 360（auto 模式，与预览 lineHeight 1.5 对齐）
const LINE_15 = { line: 360, lineRule: LineRuleType.AUTO };

export async function renderDocx(content: ResumeContent, templateId: string): Promise<Buffer> {
  const tpl = getTemplate(templateId);
  const c = tpl.colors;
  const b = content.basic;
  const F = PRINT.fontSize;

  const sectionTitle = (text: string) =>
    new Paragraph({
      children: [tr({ text, bold: true, size: S(F.sectionTitle), color: hex(c.primary) })],
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 6, color: hex(c.line), space: 2 },
        left: { style: BorderStyle.SINGLE, size: 24, color: hex(c.primary), space: 6 },
      },
      indent: { left: 80 },
      spacing: { before: tw(SP.sectionBefore), after: tw(SP.sectionAfter), ...LINE_15 },
    });

  const body = (text: string, opts: any = {}) =>
    new Paragraph({ children: [tr({ text, size: S(F.body), color: hex(c.text), ...opts })], spacing: { after: tw(SP.bodyAfter), ...LINE_15 } });

  // 渲染章节内容到给定数组（双栏/单栏共用）
  // firstInBlock: 当前条目是否为该章节第一条（第一条不加 blockAfter 前置间距，靠 sectionTitle.after 衔接）
  const renderSection = (children: any[], key: string) => {
    switch (key) {
      case "summary":
        if (!content.basic.summary) return;
        children.push(sectionTitle("个人简介"));
        lines(content.basic.summary).forEach((l) => children.push(body(l)));
        break;
      case "works":
        if (!content.works.length) return;
        children.push(sectionTitle("工作经历"));
        content.works.forEach((w, i) => {
          children.push(
            new Paragraph({
              children: [
                tr({ text: `${w.role} · ${w.company}`, bold: true, size: S(F.body * SP.inlineTitleScale), color: hex(c.text) }),
                tr({ text: `\t${w.start} - ${w.current ? "至今" : w.end}`, size: S(F.small), color: hex(c.muted) }),
              ],
              tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
              // 条目前置间距=blockAfter（首条除外，首条靠 sectionTitle.after 衔接，与预览一致）
              spacing: { before: i === 0 ? 0 : tw(SP.blockAfter), ...LINE_15 },
            })
          );
          splitBulletLines(w.description).forEach((l) =>
            children.push(
              new Paragraph({ children: [tr({ text: `- ${l}`, size: S(F.bullet), color: hex(c.text) })], indent: { left: 360 }, spacing: { after: tw(SP.bulletAfter), ...LINE_15 } })
            )
          );
        });
        break;
      case "educations":
        if (!content.educations.length) return;
        children.push(sectionTitle("教育经历"));
        content.educations.forEach((e, i) => {
          children.push(
            new Paragraph({
              children: [
                tr({ text: `${e.school} · ${e.major} · ${e.degree}`, bold: true, size: S(F.body * SP.inlineTitleScale), color: hex(c.text) }),
                tr({ text: `\t${e.start} - ${e.end}`, size: S(F.small), color: hex(c.muted) }),
              ],
              tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
              spacing: { before: i === 0 ? 0 : tw(SP.blockAfter), ...LINE_15 },
            })
          );
          if (e.description) lines(e.description).forEach((l) => children.push(body(l)));
        });
        break;
      case "projects":
        if (!content.projects.length) return;
        children.push(sectionTitle("项目经历"));
        content.projects.forEach((p, i) => {
          children.push(
            new Paragraph({
              children: [
                tr({ text: `${p.name} · ${p.role}`, bold: true, size: S(F.body * SP.inlineTitleScale), color: hex(c.text) }),
                tr({ text: `\t${p.start} - ${p.end}`, size: S(F.small), color: hex(c.muted) }),
              ],
              tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
              spacing: { before: i === 0 ? 0 : tw(SP.blockAfter), ...LINE_15 },
            })
          );
          if (p.link) children.push(body(p.link, { color: hex(c.accent) }));
          splitBulletLines(p.description).forEach((l) =>
            children.push(
              new Paragraph({ children: [tr({ text: `- ${l}`, size: S(F.bullet), color: hex(c.text) })], indent: { left: 360 }, spacing: { after: tw(SP.bulletAfter), ...LINE_15 } })
            )
          );
        });
        break;
      case "skills":
        if (!content.skills.length) return;
        children.push(sectionTitle("技能"));
        content.skills.forEach((g) => {
          // 技能胶囊：分类加粗 + 每个技能一个 softShading run（与预览/PDF 一致）
          const runs: any[] = [tr({ text: `${g.category}：`, bold: true, size: S(F.body), color: hex(c.text) })];
          splitSkills(g.items).forEach((s) => {
            runs.push(tr({ text: ` ${s} `, size: S(F.bullet), color: hex(c.primary), shading: { type: ShadingType.SOLID, fill: hex(soften(c.primary, 0.08)), color: hex(soften(c.primary, 0.08)) } }));
            runs.push(tr({ text: " ", size: S(F.bullet) }));
          });
          children.push(
            new Paragraph({
              children: runs,
              spacing: { after: tw(SP.bodyAfter), ...LINE_15 },
            })
          );
        });
        break;
    }
  };

  // 基本信息附加行：出生年月(含年龄)、性别、当前状态、期望薪资、工作年限
  const extra: string[] = [];
  const age = calcAge(b.birthday);
  if (b.birthday) extra.push(`出生：${b.birthday}${age ? `（${age}岁）` : ""}`);
  if (b.gender) extra.push(`性别：${b.gender}`);
  if (b.currentStatus) extra.push(`状态：${b.currentStatus}`);
  if (b.expectedSalary) extra.push(`期望薪资：${b.expectedSalary}`);
  if (b.workYears) extra.push(`工作年限：${b.workYears}`);

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: "SimSun", hAnsi: "SimSun", eastAsia: "SimSun" },
            // 默认字体设为 1pt（size=2 half-points）：仅影响表格后隐含空段落（无 TextRun 的段落标记），
            // 把隐含段高度从 ~18pt 压到 ~1pt，使表格行高可逼近整页高度而不溢出。
            // 所有正文 TextRun 均显式设置了 size: S(F.xxx)，不受此默认值影响。
            size: 2,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          // A4 纸张（twips: 1pt = 20 twips）。双栏表格铺满全页（margin 0），单栏用页面边距留白
          page: {
            size: { width: Math.round(PRINT.page.width * 20), height: Math.round(PRINT.page.height * 20) },
            margin: {
              // 显式声明 header/footer/gutter = 0 twips：
              // docx 库在不显式传入时默认写入 w:header="708" w:footer="708"（≈0.5 inch），
              // Word 在计算"可用于正文的页面高度"时即使页眉页脚完全为空也会先扣掉这两段距离，
              // 导致双栏 0-margin Section 实际可用高度 < 标称 A4 高（841.89pt），
              // 表格行高接近整页时必然溢出到第 2 页 → 末尾出现空白页。
              // 显式归零后页眉/页脚不再占用，实际内容高等于标称 A4 内容高。
              // Gutter 同理归零避免装订边距占用。
              header: 0,
              footer: 0,
              gutter: 0,
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              ...(tpl.layout !== "two-column"
                ? {
                    top: PRINT.margin * 20,
                    right: PRINT.margin * 20,
                    bottom: PRINT.margin * 20,
                    left: PRINT.margin * 20,
                  }
                : {}),
            },
          },
        },
        children: buildLayout(tpl, content, b, extra, renderSection),
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// 根据模板布局生成 children：双栏用表格实现侧边栏，单栏用顺序段落
function buildLayout(
  tpl: TemplateConfig,
  content: ResumeContent,
  b: ResumeContent["basic"],
  extra: string[],
  renderSection: (children: any[], key: string) => void
): any[] {
  const c = tpl.colors;
  const F = PRINT.fontSize;

  if (tpl.layout === "two-column" && tpl.sidebarBasic) {
    const sidebarChildren: any[] = [];
    sidebarChildren.push(
      new Paragraph({ children: [tr({ text: b.name || "姓名", bold: true, size: S(F.sidebarName), color: "FFFFFF" })], spacing: { before: 800, after: tw(SP.sideNameAfter), ...LINE_15 } })
    );
    if (b.title)
      sidebarChildren.push(new Paragraph({ children: [tr({ text: b.title, size: S(F.sidebarTitle), color: "CBD5E1" })], spacing: { after: tw(SP.sideTitleAfter), ...LINE_15 } }));
    sidebarChildren.push(
      new Paragraph({ children: [tr({ text: "联系方式", bold: true, size: S(F.sidebarLabel), color: "FFFFFF" })], spacing: { after: tw(SP.sideLabelAfter), before: tw(SP.sideLabelBefore), ...LINE_15 } })
    );
    if (b.phone) sidebarChildren.push(new Paragraph({ children: [tr({ text: `电话：${b.phone}`, size: S(F.sidebarField), color: "E2E8F0" })], spacing: { after: tw(SP.sideFieldAfter), ...LINE_15 } }));
    if (b.email) sidebarChildren.push(new Paragraph({ children: [tr({ text: `邮箱：${b.email}`, size: S(F.sidebarField), color: "E2E8F0" })], spacing: { after: tw(SP.sideFieldAfter), ...LINE_15 } }));
    if (b.location) sidebarChildren.push(new Paragraph({ children: [tr({ text: `地址：${b.location}`, size: S(F.sidebarField), color: "E2E8F0" })], spacing: { after: tw(SP.sideFieldAfter), ...LINE_15 } }));
    if (b.website) sidebarChildren.push(new Paragraph({ children: [tr({ text: `主页：${b.website}`, size: S(F.sidebarField), color: "E2E8F0" })], spacing: { after: tw(SP.sideFieldAfter), ...LINE_15 } }));
    extra.forEach((l) =>
      sidebarChildren.push(new Paragraph({ children: [tr({ text: l, size: S(F.sidebarField), color: "E2E8F0" })], spacing: { after: tw(SP.sideFieldAfter), ...LINE_15 } }))
    );

    const mainChildren: any[] = [];
    tpl.sectionOrder.forEach((k) => renderSection(mainChildren, k));
    if (mainChildren.length === 0) mainChildren.push(new Paragraph({ children: [tr({ text: "（暂无内容）", size: S(F.body), color: hex(c.text) })] }));

    // 侧栏/主区宽度（twips = pt × 20），与 PDF 全页 190pt 侧栏比例完全一致
    const sideTw = Math.round(PRINT.sidebarWidth * 20);
    const mainTw = Math.round((PRINT.page.width - PRINT.sidebarWidth) * 20);
    const tableTw = Math.round(PRINT.page.width * 20);
    // cellPad top/bottom = 0：Word 将 cellPad 上下边距叠加在 AT_LEAST 行高之外（实测验证），
    // 40pt×2=80pt 的 cellPad 会使行高+隐含段超过页高溢出到第 2 页。
    // 改为 0 后，用首个段落的 SpaceBefore=800twips(40pt) 替代视觉顶部间距。
    // 水平内边距 800twips(40pt) 保留，与 PDF/预览侧栏 padding 一致。
    const cellPad = { top: 0, bottom: 0, left: 800, right: 800 };
    const sidebarCell = new TableCell({
      width: { size: sideTw, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: hex(c.sidebar || "#1E293B"), color: "auto" },
      margins: cellPad,
      verticalAlign: VerticalAlign.TOP,
      children: sidebarChildren,
    });
    const mainCell = new TableCell({
      width: { size: mainTw, type: WidthType.DXA },
      margins: cellPad,
      verticalAlign: VerticalAlign.TOP,
      children: mainChildren,
    });

    // 页面高度（twips）= PRINT.page.height * 20，与 Document.section.page.size.height 保持完全一致
    const pageTw = Math.round(PRINT.page.height * 20);
    // 双栏表格行高策略：HeightRule.AT_LEAST + cellPadTB=0 + defaultFont=1pt
    //  三重优化后，隐含空段总高 ≈ 3pt，仅需 reserve=120twips(6pt) 安全余量即可保证不溢出。
    //  对应空内容时 rowH = 841.9 - 6 = 835.9pt → 侧栏背景从页顶铺到距页底仅 6pt 处（≈0.2cm，肉眼不可见）。
    //  内容多时 AT_LEAST 自动撑高，Word 默认允许行跨页拆分，不裁剪、不产生末尾空白页。
    const reserveTw = 120; // 6pt 安全余量（隐含段≈3pt + 余量3pt）
    const rowTw = pageTw - reserveTw;
    const table = new Table({
      width: { size: tableTw, type: WidthType.DXA },
      columnWidths: [sideTw, mainTw],
      borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } },
      rows: [new TableRow({ height: { value: rowTw, rule: HeightRule.AT_LEAST }, children: [sidebarCell, mainCell] })],
    });

    return [table];
  }

  // 单栏布局——间距与预览/PDF 一致
  // 姓名底带：姓名/职位/联系方式/附加信息四段都加主色 8% 软底 shading（与预览/PDF 一致）
  const headerShading = { type: ShadingType.SOLID, fill: hex(soften(c.primary, 0.08)), color: hex(soften(c.primary, 0.08)) };
  const children: any[] = [];
  children.push(
    new Paragraph({ children: [tr({ text: b.name || "姓名", bold: true, size: S(F.name), color: hex(c.primary) })], shading: headerShading, spacing: { after: tw(SP.nameAfter), ...LINE_15 } })
  );
  if (b.title) {
    children.push(
      new Paragraph({ children: [tr({ text: b.title, size: S(F.title), color: hex(c.muted) })], shading: headerShading, spacing: { after: tw(SP.titleAfter), ...LINE_15 } })
    );
  }
  const contact = [b.phone, b.email, b.location, b.website].filter(Boolean).join("  |  ");
  if (contact) {
    children.push(
      new Paragraph({ children: [tr({ text: contact, size: S(F.small), color: hex(c.muted) })], shading: headerShading, spacing: { after: tw(SP.contactAfter), ...LINE_15 } })
    );
  }
  if (extra.length) {
    children.push(
      new Paragraph({ children: [tr({ text: extra.join("  |  "), size: S(F.small), color: hex(c.muted) })], shading: headerShading, spacing: { after: tw(SP.extraAfter), ...LINE_15 } })
    );
  }
  tpl.sectionOrder.forEach((k) => renderSection(children, k));
  return children;
}
