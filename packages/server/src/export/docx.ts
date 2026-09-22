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

export async function renderDocx(content: ResumeContent, templateId: string, pageBreakIds: string[] = []): Promise<Buffer> {
  const tpl = getTemplate(templateId);
  const c = tpl.colors;
  const b = content.basic;
  const F = PRINT.fontSize;

  // 章节标题：左竖条 + 下划线，用「1 行 2 列表格」实现（窄列填充主色=竖条，文字列带下边框=下划线）。
  // 不用段落左边框：Word/WPS 的段落边框覆盖整个段落框（随行距、border space 变化），
  // 竖条高度不可控（曾远高于文字）；表格单元格底色严格等于行高，竖条高度稳定且与文字一致。
  // 表格自身没有 spacing，前后用 EXACT 行高的空段落占位承载章节间距
  // （空段落默认字号 1pt，高度即 EXACT 行距值）；首个章节不留 blockAfter（上方是页首留白/头部带）。
  const sectionTitle = (text: string, first = false): any[] => {
    const spacer = (h: number) =>
      new Paragraph({ spacing: { before: 0, after: 0, line: h, lineRule: LineRuleType.EXACT }, children: [] });
    // 主内容区宽度（twips）：双栏=主栏宽-主栏单元格左右边距(800×2)；单栏=页宽-左右页边距
    const contentW =
      tpl.layout === "two-column" && tpl.sidebarBasic
        ? Math.round((PRINT.page.width - PRINT.sidebarWidth) * 20) - 1600
        : Math.round((PRINT.page.width - PRINT.margin * 2) * 20);
    const barW = 40; // 竖条宽 2pt（与预览竖条宽度一致）
    const titleTable = new Table({
      width: { size: contentW, type: WidthType.DXA },
      columnWidths: [barW, contentW - barW],
      borders: {
        top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
        insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
      },
      rows: [
        new TableRow({
          children: [
            // 竖条列：主色填充，高度=行高（=文字列行高）
            new TableCell({
              width: { size: barW, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: hex(c.primary), color: "auto" },
              margins: { top: 0, bottom: 0, left: 0, right: 0 },
              children: [new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: [] })],
            }),
            // 文字列：标题文字 + 底边框下划线；EXACT 15.5pt 行高压紧行高（13pt 宋体加粗可容纳）
            new TableCell({
              width: { size: contentW - barW, type: WidthType.DXA },
              margins: { top: 0, bottom: 0, left: 80, right: 0 },
              borders: { bottom: { style: BorderStyle.SINGLE, size: 6, color: hex(c.line) } },
              children: [
                new Paragraph({
                  children: [tr({ text, bold: true, size: S(F.sectionTitle), color: hex(c.primary) })],
                  spacing: { before: 0, after: 0, line: 310, lineRule: LineRuleType.EXACT },
                }),
              ],
            }),
          ],
        }),
      ],
    });
    return [spacer(tw(SP.sectionBefore + (first ? 0 : SP.blockAfter))), titleTable, spacer(tw(SP.sectionAfter))];
  };

  const body = (text: string, opts: any = {}) =>
    new Paragraph({ children: [tr({ text, size: S(F.body), color: hex(c.text), ...opts })], spacing: { after: tw(SP.bodyAfter), ...LINE_15 } });

  // 渲染章节内容到给定数组（双栏/单栏共用）
  // firstInBlock: 当前条目是否为该章节第一条（第一条不加 blockAfter 前置间距，靠 sectionTitle.after 衔接）
  const renderSection = (children: any[], key: string) => {
    switch (key) {
      case "summary":
        if (!content.basic.summary) return;
        children.push(...sectionTitle("个人简介", children.length === 0));
        lines(content.basic.summary).forEach((l) => children.push(body(l)));
        break;
      case "works":
        if (!content.works.length) return;
        children.push(...sectionTitle("工作经历", children.length === 0));
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
          splitBulletLines(w.description).forEach((l, _i, arr) =>
            children.push(
              new Paragraph({ children: [tr({ text: arr.length > 1 ? `- ${l}` : l, size: S(arr.length > 1 ? F.bullet : F.body), color: hex(c.text) })], indent: { left: arr.length > 1 ? 360 : 0 }, spacing: { after: tw(SP.bulletAfter), ...LINE_15 } })
            )
          );
        });
        break;
      case "educations":
        if (!content.educations.length) return;
        children.push(...sectionTitle("教育经历", children.length === 0));
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
        children.push(...sectionTitle("项目经历", children.length === 0));
        content.projects.forEach((p, i) => {
          children.push(
            new Paragraph({
              children: [
                tr({ text: `${p.name}${p.company ? ` · ${p.company}` : ""} · ${p.role}`, bold: true, size: S(F.body * SP.inlineTitleScale), color: hex(c.text) }),
                tr({ text: `\t${p.start} - ${p.end}`, size: S(F.small), color: hex(c.muted) }),
              ],
              tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
              spacing: { before: i === 0 ? 0 : tw(SP.blockAfter), ...LINE_15 },
            })
          );
          if (p.link) children.push(body(p.link, { color: hex(c.accent) }));
          splitBulletLines(p.description).forEach((l, _i, arr) =>
            children.push(
              new Paragraph({ children: [tr({ text: arr.length > 1 ? `- ${l}` : l, size: S(arr.length > 1 ? F.bullet : F.body), color: hex(c.text) })], indent: { left: arr.length > 1 ? 360 : 0 }, spacing: { after: tw(SP.bulletAfter), ...LINE_15 } })
            )
          );
        });
        break;
      case "skills":
        if (!content.skills.length) return;
        children.push(...sectionTitle("技能", children.length === 0));
        content.skills.forEach((g) => {
          // 技能胶囊：分类加粗 + 每个技能一个 softShading run（与预览/PDF 一致）。
          // SimSun 全角冒号字形紧贴前一字符（0 间距过挤），直接插半角空格（5pt）又过宽，
          // 故用小字号空格精确控制——半角空格宽度 = 字号的一半：
          // 分类与冒号之间 2.5pt（5pt 字号空格），冒号与胶囊之间 1pt（2pt 字号空格）。
          const gapBeforeColon = () => tr({ text: " ", size: S(5) });
          const gapBeforeCapsule = () => tr({ text: " ", size: S(2) });
          const runs: any[] = [
            tr({ text: g.category, bold: true, size: S(F.body), color: hex(c.text) }),
            gapBeforeColon(),
            tr({ text: "：", bold: true, size: S(F.body), color: hex(c.text) }),
          ];
          splitSkills(g.items).forEach((s) => {
            runs.push(gapBeforeCapsule());
            runs.push(tr({ text: ` ${s} `, size: S(F.bullet), color: hex(c.primary), shading: { type: ShadingType.SOLID, fill: hex(soften(c.primary, 0.08)), color: hex(soften(c.primary, 0.08)) } }));
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

    // 侧栏/主区宽度（twips = pt × 20），与 PDF 全页侧栏比例完全一致
    const sideTw = Math.round(PRINT.sidebarWidth * 20);
    const mainTw = Math.round((PRINT.page.width - PRINT.sidebarWidth) * 20);
    const tableTw = Math.round(PRINT.page.width * 20);
    // 上下留白：主区单元格加 top/bottom padding（= PRINT.margin，40pt），
    // 避免正文首行贴近页面顶端、满页时末行贴页底。侧栏 cellPad 上下保持 0，
    // 用首个段落的 SpaceBefore=800twips(40pt) 提供视觉顶部间距，深色背景仍贴页顶。
    // Word 会把 cellPad 上下边距叠加在 AT_LEAST 行高之外，因此下方 rowTw 需等量扣减，
    // 否则行高+隐含段超过页高会溢出到第 2 页（且侧栏底部出现白边）。
    // 水平内边距：侧栏用 sidebarPad(24pt=480twips)，主区保持 800twips(40pt)，
    // 与 PDF/预览侧栏 padding 一致。
    const mainPadV = PRINT.margin;
    const sideCellPad = { top: 0, bottom: 0, left: tw(PRINT.sidebarPad), right: tw(PRINT.sidebarPad) };
    const mainCellPad = { top: tw(mainPadV), bottom: tw(mainPadV), left: 800, right: 800 };
    const sidebarCell = new TableCell({
      width: { size: sideTw, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: hex(c.sidebar || "#1E293B"), color: "auto" },
      margins: sideCellPad,
      verticalAlign: VerticalAlign.TOP,
      children: sidebarChildren,
    });
    const mainCell = new TableCell({
      width: { size: mainTw, type: WidthType.DXA },
      margins: mainCellPad,
      verticalAlign: VerticalAlign.TOP,
      children: mainChildren,
    });

    // 页面高度（twips）= PRINT.page.height * 20，与 Document.section.page.size.height 保持完全一致
    const pageTw = Math.round(PRINT.page.height * 20);
    // 表格后显式追加一个「隐藏段落标记」的空段落（w:pPr/w:rPr/w:vanish）：
    //  - Word 要求文档不能以表格结尾，若不显式提供段落，Word 会自动补一个按默认字号
    //    计算行高（≈3pt）的隐含段落，迫使行高预留量变大 → 侧栏底部出现可见白边。
    //  - 段落标记设为隐藏文本（vanish）后高度为 0，这是消除表格末尾空段的标准做法；
    //    再叠加 EXACT 1pt 行距 + 1pt 字号双保险（仅在用户开启「显示隐藏文字」时生效）。
    //  - 预留量因此可压缩到 1pt，侧栏背景几乎铺满整页（缺口 ≈0.35mm，肉眼不可见）。
    const tailPara = new Paragraph({
      run: { vanish: true, size: 2 },
      spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
      children: [],
    });
    // 双栏表格行高策略：HeightRule.ATLEAST + cellPadTB=0 + defaultFont=1pt + 隐藏尾段
    //  隐藏尾段（vanish）正常显示时高度为 0，预留仅 4 twips(0.2pt ≈ 0.07mm，低于一个
    //  设备像素) 防止 twips 舍入导致溢出到第 2 页；侧栏背景视觉上完全贴住页底。
    //  内容多时 AT_LEAST 自动撑高，Word 默认允许行跨页拆分，不裁剪、不产生末尾空白页。
    //  （注：仅当用户在 Word 中手动开启「显示隐藏文字」时尾段才占 1pt，属可接受的边缘情况。）
    const reserveTw = 4; // 0.2pt 防舍入余量
    // 行高 = 页高 - 主区上下 cellPad - 余量：cellPad 被等量扣减后，
    // 主区实际内容高度不变，侧栏背景仍几乎铺满整页（缺口 ≈0.35mm，肉眼不可见）。
    const rowTw = pageTw - reserveTw - tw(mainPadV) * 2;
    const table = new Table({
      width: { size: tableTw, type: WidthType.DXA },
      columnWidths: [sideTw, mainTw],
      borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } },
      rows: [new TableRow({ height: { value: rowTw, rule: HeightRule.ATLEAST }, children: [sidebarCell, mainCell] })],
    });

    return [table, tailPara];
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
