import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import PDFDocument from "pdfkit";
import type { ResumeContent } from "@resume-agent/shared";
import { getTemplate, splitSkills, calcAge, soften, PRINT, splitBulletLines } from "@resume-agent/shared";
import { renderDocx } from "./docx.js";

// ============================================================
// 新的导出策略（优先）：renderDocx → Microsoft Word COM → PDF
// DOCX 渲染已验证效果远好于手写 pdfkit 坐标布局（技能胶囊自动换行、
// 个人信息底带对齐、行内标题右对齐时间等与浏览器预览一致）。
// 若系统未安装 Word / Word COM 调用失败，则降级走 pdfkit 手写实现。
// ============================================================

/**
 * 调用本机 Microsoft Word（通过 PowerShell + COM）将 DOCX Buffer 转换为 PDF Buffer。
 * 依赖：Windows + 已安装 Microsoft Word（已在 WINWORD.EXE 路径验证通过）。
 */
export async function convertDocxToPdf(docxBuf: Buffer): Promise<Buffer> {
  if (process.platform !== "win32") {
    throw new Error(`convertDocxToPdf only supported on Windows (platform=${process.platform})`);
  }
  const tmpDir = fs.realpathSync(os.tmpdir());
  const tag = `resume_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const docxPath = path.join(tmpDir, `${tag}.docx`);
  const pdfPath = path.join(tmpDir, `${tag}.pdf`);
  const ps1Path = path.join(tmpDir, `${tag}.ps1`);

  const cleanup = () => {
    for (const p of [docxPath, pdfPath, ps1Path]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  };

  try {
    fs.writeFileSync(docxPath, docxBuf);

    // PowerShell 脚本：通过 Word COM 打开 DOCX 并 SaveAs(wdfFormatPDF = 17)
    // 必须使用 COM 方式而非命令行参数：WINWORD.EXE /pt 等命令行打印不可控且易卡进程。
    const psScript = `
$ErrorActionPreference = "Stop"
$docxPath = '${docxPath.replace(/'/g, "''")}'
$pdfPath  = '${pdfPath.replace(/'/g, "''")}'
$word = $null
$doc  = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0  # wdAlertsNone
  $doc = $word.Documents.Open($docxPath, $false, $true)  # ReadOnly = true
  # wdFormatPDF = 17
  $doc.SaveAs([ref]$pdfPath, [ref]17)
  $doc.Close($false)
  $word.Quit()
} finally {
  if ($doc -ne $null) {
    try { $doc.Close($false) } catch {}
    [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc)
  }
  if ($word -ne $null) {
    try { $word.Quit() } catch {}
    [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($word)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`.trim();
    fs.writeFileSync(ps1Path, psScript, "utf8");

    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
      { timeout: 90000, maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );

    // generous poll for the PDF output file
    let waited = 0;
    while (!fs.existsSync(pdfPath) && waited < 30000) {
      await new Promise((r) => setTimeout(r, 200));
      waited += 200;
    }
    if (!fs.existsSync(pdfPath)) {
      throw new Error("Word COM SaveAs PDF: output file not found within timeout");
    }
    return fs.readFileSync(pdfPath);
  } finally {
    cleanup();
  }
}

/**
 * 公共 PDF 导出入口：
 *  1) 先尝试 DOCX → Word COM → PDF（排版效果与 Word 导出一致，技能胶囊等更美观）
 *  2) 若失败则回退到 pdfkit 手写坐标布局（仍可用，但排版略逊）
 */
export async function renderPdf(content: ResumeContent, templateId: string): Promise<Buffer> {
  try {
    const docxBuf = await renderDocx(content, templateId);
    return await convertDocxToPdf(docxBuf);
  } catch (primaryErr) {
    // eslint-disable-next-line no-console
    console.warn("[renderPdf] DOCX→Word path failed, fallback to pdfkit. Reason:", (primaryErr as any)?.message ?? primaryErr);
    return renderPdfFallback(content, templateId);
  }
}

// =====================================================================
// 下方为原先的 pdfkit 手写坐标布局（降级保留）。
// 历史修复内容：hex color 直传、pageAdded 重画侧栏、pg.setY() 重置个人信息区、
// skillRow 手动计算 categoryWidth 并设置 cx 起始位置、lineCount 动态高度。
// =====================================================================

const FONT_PATH = "C:\\Windows\\Fonts\\STSONG.TTF";

function lines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function hexColor(hex: string): string {
  return hex;
}

function createPaginator(doc: PDFKit.PDFDocument, top: number, bottom: number, onPage?: () => void) {
  let y = top;
  return {
    y() { return y; },
    setY(v: number) { y = v; },
    space(h: number) {
      if (y + h > bottom) {
        doc.addPage();
        onPage?.();
        y = top;
      }
    },
    writeLines(arr: string[], write: (line: string, yy: number) => void, lineHeight: (line: string) => number) {
      for (const l of arr) {
        const h = lineHeight(l);
        this.space(h);
        write(l, y);
        y += h;
      }
    },
  };
}

/** pdfkit 降级实现 */
export async function renderPdfFallback(content: ResumeContent, templateId: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument({ size: [PRINT.page.width, PRINT.page.height], margin: 0, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    const tpl = getTemplate(templateId);
    const c = tpl.colors;
    const b = content.basic;
    const F = PRINT.fontSize;
    const S = PRINT.spacing;
    const pad = PRINT.margin;

    doc.registerFont("CJK", FONT_PATH);

    const extraLines: string[] = [];
    const age = calcAge(b.birthday);
    if (b.birthday) extraLines.push(`出生：${b.birthday}${age ? `（${age}岁）` : ""}`);
    if (b.gender) extraLines.push(`性别：${b.gender}`);
    if (b.currentStatus) extraLines.push(`状态：${b.currentStatus}`);
    if (b.expectedSalary) extraLines.push(`期望薪资：${b.expectedSalary}`);
    if (b.workYears) extraLines.push(`工作年限：${b.workYears}`);

    const pageBottom = PRINT.page.height - PRINT.margin;

    if (tpl.layout === "two-column" && tpl.sidebarBasic) {
      const sidebarW = PRINT.sidebarWidth;
      const mainW = PRINT.page.width - sidebarW;
      const sideColor = hexColor(c.sidebar || "#1E293B");

      const drawSidebarBg = () => {
        doc.save();
        doc.rect(0, 0, sidebarW, PRINT.page.height).fill(sideColor);
        doc.restore();
      };
      drawSidebarBg();
      doc.on("pageAdded", drawSidebarBg);

      doc.font("CJK").fontSize(F.sidebarName).fillColor("#FFFFFF");
      let sy = pad;
      doc.text(b.name || "姓名", pad, sy, { width: sidebarW - pad * 2, lineGap: S.lineGap });
      sy = doc.y + S.sideNameAfter;
      if (b.title) {
        doc.fontSize(F.sidebarTitle).fillColor("#93C5FD");
        doc.text(b.title, pad, sy, { width: sidebarW - pad * 2, lineGap: S.lineGap });
        sy = doc.y + S.sideTitleAfter;
      }
      sy += S.sideLabelBefore;
      doc.fontSize(F.sidebarLabel).fillColor("#FFFFFF");
      doc.text("联系方式", pad, sy, { width: sidebarW - pad * 2, lineGap: S.lineGap });
      sy = doc.y + S.sideLabelAfter;
      doc.fontSize(F.sidebarField).fillColor("#CBD5E1");
      const sideFields = [
        b.phone ? `电话：${b.phone}` : null,
        b.email ? `邮箱：${b.email}` : null,
        b.location ? `地址：${b.location}` : null,
        b.website ? `主页：${b.website}` : null,
        ...extraLines,
      ].filter(Boolean) as string[];
      for (const line of sideFields) {
        doc.text(line, pad, sy, { width: sidebarW - pad * 2, lineGap: S.lineGap });
        sy = doc.y + S.sideFieldAfter;
      }

      const pg = createPaginator(doc, pad, pageBottom, drawSidebarBg);
      const mx = sidebarW + pad;
      const mw = mainW - pad * 2;

      const textAt = (str: string, size: number, color: string, opts: any = {}) => {
        doc.font("CJK").fontSize(size).fillColor(color);
        doc.text(str, mx, pg.y(), { width: mw, lineGap: S.lineGap, ...opts });
        return doc.y;
      };
      const advance = (toY: number) => { pg.setY(Math.max(toY, pg.y())); };

      const sectionTitle = (txt: string) => {
        pg.space(F.sectionTitle * S.lineHeight + S.sectionBefore);
        const tY = pg.y();
        doc.save();
        doc.rect(mx, tY, 4, F.sectionTitle).fill(c.primary);
        doc.restore();
        const endY = textAt(txt, F.sectionTitle, c.primary, { indent: S.bulletAfter + S.lineGap });
        const lineY = tY + F.sectionTitle * S.sectionLineOffset;
        doc.moveTo(mx, lineY).lineTo(mx + mw, lineY).strokeColor(c.line).lineWidth(0.5).stroke();
        pg.setY(Math.max(endY, tY + F.sectionTitle * S.lineHeight + S.sectionAfter));
      };

      const body = (str: string, size = F.body) => {
        pg.space(size * S.lineHeight + S.lineGap);
        const endY = textAt(str, size, c.text);
        pg.setY(endY + S.bodyAfter);
      };

      const bullet = (str: string, size = F.bullet) => {
        pg.space(size * S.lineHeight + S.lineGap);
        const endY = textAt(`- ${str}`, size, c.text);
        pg.setY(endY + S.bulletAfter);
      };

      const inlineTitle = (leftStr: string, rightStr: string) => {
        const leftSize = F.body * S.inlineTitleScale;
        pg.space(leftSize * S.lineHeight + S.lineGap);
        const tY = pg.y();
        doc.font("CJK").fontSize(leftSize).fillColor(c.text);
        doc.text(leftStr, mx, tY, { width: mw, continued: true, lineBreak: false });
        doc.font("CJK").fontSize(F.small).fillColor(c.muted);
        doc.text(rightStr, { width: mw, align: "right", lineBreak: false });
        pg.setY(doc.y + 2);
      };

      const skillRow = (g: ResumeContent["skills"][number]) => {
        pg.space(F.body * S.lineHeight + S.lineGap);
        const rowY = pg.y();
        doc.font("CJK").fontSize(F.body).fillColor(c.text);
        const categoryLabel = `${g.category}：`;
        const categoryWidth = doc.widthOfString(categoryLabel);
        doc.text(categoryLabel, mx, rowY, { width: mw, lineBreak: false });
        const skills = splitSkills(g.items);
        const padH = S.bulletAfter;
        const gap = 4;
        const labelGap = 6;
        let cx = mx + categoryWidth + labelGap;
        let lineTopY = rowY;
        let lineCount = 1;
        const softBg = soften(c.primary, 0.08);
        const rightEdge = mx + mw;
        const capsuleH = F.bullet * 1.6;
        const capTopOffset = F.bullet * 1.1;
        const lineIncrement = Math.max(F.body * S.lineHeight, F.bullet * S.lineHeight);
        for (const s of skills) {
          doc.font("CJK").fontSize(F.bullet);
          const w = doc.widthOfString(s) + padH * 2;
          if (cx + w > rightEdge) {
            lineTopY += lineIncrement;
            cx = mx;
            lineCount += 1;
          }
          const cy = lineTopY - capTopOffset;
          doc.save();
          doc.roundedRect(cx, cy, w, capsuleH, 2).fill(softBg);
          doc.restore();
          doc.font("CJK").fontSize(F.bullet).fillColor(c.primary);
          doc.text(s, cx + padH, lineTopY, { lineBreak: false, width: w });
          cx += w + gap;
        }
        const lastLineBottom = lineTopY - capTopOffset + capsuleH;
        const groupBottom = lastLineBottom + S.bodyAfter;
        const totalHeight = groupBottom - rowY + S.lineGap;
        pg.setY(rowY + totalHeight);
      };

      const renderSection = (key: string) => {
        switch (key) {
          case "summary":
            if (!content.basic.summary) return;
            sectionTitle("个人简介");
            lines(content.basic.summary).forEach((l) => body(l));
            break;
          case "works":
            if (!content.works.length) return;
            sectionTitle("工作经历");
            content.works.forEach((w) => {
              inlineTitle(`${w.role} · ${w.company}`, `${w.start} - ${w.current ? "至今" : w.end}`);
              splitBulletLines(w.description).forEach((l) => bullet(l));
              pg.setY(pg.y() + S.blockAfter);
            });
            break;
          case "educations":
            if (!content.educations.length) return;
            sectionTitle("教育经历");
            content.educations.forEach((e) => {
              inlineTitle(`${e.school} · ${e.major} · ${e.degree}`, `${e.start} - ${e.end}`);
              if (e.description) lines(e.description).forEach((l) => body(l));
              pg.setY(pg.y() + S.blockAfter);
            });
            break;
          case "projects":
            if (!content.projects.length) return;
            sectionTitle("项目经历");
            content.projects.forEach((p) => {
              inlineTitle(`${p.name} · ${p.role}`, `${p.start} - ${p.end}`);
              if (p.link) {
                pg.space(F.small * S.lineHeight + S.lineGap);
                const lY = textAt(p.link, F.small, c.accent);
                pg.setY(lY + S.bulletAfter);
              }
              splitBulletLines(p.description).forEach((l) => bullet(l));
              pg.setY(pg.y() + S.blockAfter);
            });
            break;
          case "skills":
            if (!content.skills.length) return;
            sectionTitle("技能");
            content.skills.forEach((g) => skillRow(g));
            break;
        }
      };

      tpl.sectionOrder.forEach(renderSection);
    } else {
      const x = PRINT.margin;
      const cw = PRINT.page.width - PRINT.margin * 2;
      const pg = createPaginator(doc, PRINT.margin, pageBottom);

      const textAt = (str: string, size: number, color: string, opts: any = {}) => {
        doc.font("CJK").fontSize(size).fillColor(color);
        doc.text(str, x, pg.y(), { width: cw, lineGap: S.lineGap, ...opts });
        return doc.y;
      };

      const headerBandBg = soften(c.primary, 0.08);
      const headerTop = pg.y();
      const headerPadV = S.nameAfter;
      const headerPadH = S.sectionBefore;
      const headerLeft = x - headerPadH;
      const headerRight = PRINT.page.width - PRINT.margin + headerPadH;
      const headerW = headerRight - headerLeft;
      const textStartY = headerTop + headerPadV;
      pg.setY(textStartY);
      const endName = textAt(b.name || "姓名", F.name, c.primary);
      pg.setY(endName + S.nameAfter);
      if (b.title) {
        const endT = textAt(b.title, F.title, c.muted);
        pg.setY(endT + S.titleAfter);
      }
      const contact = [b.phone, b.email, b.location, b.website].filter(Boolean).join("  |  ");
      if (contact) {
        pg.space(F.small * S.lineHeight + S.lineGap);
        const endC = textAt(contact, F.small, c.muted);
        pg.setY(endC + S.contactAfter);
      }
      if (extraLines.length) {
        pg.space(F.small * S.lineHeight + S.lineGap);
        const endE = textAt(extraLines.join("  |  "), F.small, c.muted);
        pg.setY(endE + S.extraAfter);
      }
      const headerBottom = pg.y() + headerPadV;
      pg.setY(headerTop);
      doc.save();
      doc.rect(headerLeft, headerTop, headerW, headerBottom - headerTop).fill(headerBandBg);
      doc.restore();
      pg.setY(textStartY);
      const endName2 = textAt(b.name || "姓名", F.name, c.primary);
      pg.setY(endName2 + S.nameAfter);
      if (b.title) {
        const endT2 = textAt(b.title, F.title, c.muted);
        pg.setY(endT2 + S.titleAfter);
      }
      if (contact) {
        pg.space(F.small * S.lineHeight + S.lineGap);
        const endC2 = textAt(contact, F.small, c.muted);
        pg.setY(endC2 + S.contactAfter);
      }
      if (extraLines.length) {
        pg.space(F.small * S.lineHeight + S.lineGap);
        const endE2 = textAt(extraLines.join("  |  "), F.small, c.muted);
        pg.setY(endE2 + S.extraAfter);
      }
      pg.setY(Math.max(pg.y(), headerBottom));

      const sectionTitle = (txt: string) => {
        pg.space(F.sectionTitle * S.lineHeight + S.sectionBefore);
        const tY = pg.y();
        doc.save();
        doc.rect(x, tY, 4, F.sectionTitle).fill(c.primary);
        doc.restore();
        textAt(txt, F.sectionTitle, c.primary, { indent: S.bulletAfter + S.lineGap });
        const lineY = tY + F.sectionTitle * S.sectionLineOffset;
        doc.moveTo(x, lineY).lineTo(x + cw, lineY).strokeColor(c.line).lineWidth(0.5).stroke();
        pg.setY(Math.max(pg.y(), tY + F.sectionTitle * S.lineHeight + S.sectionAfter));
      };

      const body = (str: string, size = F.body) => {
        pg.space(size * S.lineHeight + S.lineGap);
        const endY = textAt(str, size, c.text);
        pg.setY(endY + S.bodyAfter);
      };

      const bullet = (str: string, size = F.bullet) => {
        pg.space(size * S.lineHeight + S.lineGap);
        const endY = textAt(`- ${str}`, size, c.text);
        pg.setY(endY + S.bulletAfter);
      };

      const inlineTitle = (leftStr: string, rightStr: string) => {
        const leftSize = F.body * S.inlineTitleScale;
        pg.space(leftSize * S.lineHeight + S.lineGap);
        const tY = pg.y();
        doc.font("CJK").fontSize(leftSize).fillColor(c.text);
        doc.text(leftStr, x, tY, { width: cw, continued: true, lineBreak: false });
        doc.font("CJK").fontSize(F.small).fillColor(c.muted);
        doc.text(rightStr, { width: cw, align: "right", lineBreak: false });
        pg.setY(doc.y + 2);
      };

      const skillRow = (g: ResumeContent["skills"][number]) => {
        pg.space(F.body * S.lineHeight + S.lineGap);
        const rowY = pg.y();
        doc.font("CJK").fontSize(F.body).fillColor(c.text);
        const categoryLabel = `${g.category}：`;
        const categoryWidth = doc.widthOfString(categoryLabel);
        doc.text(categoryLabel, x, rowY, { width: cw, lineBreak: false });
        const skills = splitSkills(g.items);
        const padH = S.bulletAfter;
        const gap = 4;
        const labelGap = 6;
        let cx = x + categoryWidth + labelGap;
        let lineTopY = rowY;
        let lineCount = 1;
        const softBg = soften(c.primary, 0.08);
        const rightEdge = x + cw;
        const capsuleH = F.bullet * 1.6;
        const capTopOffset = F.bullet * 1.1;
        const lineIncrement = Math.max(F.body * S.lineHeight, F.bullet * S.lineHeight);
        for (const s of skills) {
          doc.font("CJK").fontSize(F.bullet);
          const w = doc.widthOfString(s) + padH * 2;
          if (cx + w > rightEdge) {
            lineTopY += lineIncrement;
            cx = x;
            lineCount += 1;
          }
          const cy = lineTopY - capTopOffset;
          doc.save();
          doc.roundedRect(cx, cy, w, capsuleH, 2).fill(softBg);
          doc.restore();
          doc.font("CJK").fontSize(F.bullet).fillColor(c.primary);
          doc.text(s, cx + padH, lineTopY, { lineBreak: false, width: w });
          cx += w + gap;
        }
        const lastLineBottom = lineTopY - capTopOffset + capsuleH;
        const groupBottom = lastLineBottom + S.bodyAfter;
        const totalHeight = groupBottom - rowY + S.lineGap;
        pg.setY(rowY + totalHeight);
      };

      const renderSection = (key: string) => {
        switch (key) {
          case "summary":
            if (!content.basic.summary) return;
            sectionTitle("个人简介");
            lines(content.basic.summary).forEach((l) => body(l));
            break;
          case "works":
            if (!content.works.length) return;
            sectionTitle("工作经历");
            content.works.forEach((w) => {
              inlineTitle(`${w.role} · ${w.company}`, `${w.start} - ${w.current ? "至今" : w.end}`);
              splitBulletLines(w.description).forEach((l) => bullet(l));
              pg.setY(pg.y() + S.blockAfter);
            });
            break;
          case "educations":
            if (!content.educations.length) return;
            sectionTitle("教育经历");
            content.educations.forEach((e) => {
              inlineTitle(`${e.school} · ${e.major} · ${e.degree}`, `${e.start} - ${e.end}`);
              if (e.description) lines(e.description).forEach((l) => body(l));
              pg.setY(pg.y() + S.blockAfter);
            });
            break;
          case "projects":
            if (!content.projects.length) return;
            sectionTitle("项目经历");
            content.projects.forEach((p) => {
              inlineTitle(`${p.name} · ${p.role}`, `${p.start} - ${p.end}`);
              if (p.link) {
                pg.space(F.small * S.lineHeight + S.lineGap);
                const lY = textAt(p.link, F.small, c.accent);
                pg.setY(lY + S.bulletAfter);
              }
              splitBulletLines(p.description).forEach((l) => bullet(l));
              pg.setY(pg.y() + S.blockAfter);
            });
            break;
          case "skills":
            if (!content.skills.length) return;
            sectionTitle("技能");
            content.skills.forEach((g) => skillRow(g));
            break;
        }
      };

      tpl.sectionOrder.forEach(renderSection);
    }

    doc.end();
  });
}
