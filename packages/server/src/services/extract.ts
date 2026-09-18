// 文本抽取：docx(mammoth) / pdf(pdfjs 抽文字或逐页渲染走 OCR)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// 文字型 PDF 若整篇识别文字少于该长度，视为扫描件，进入 OCR
const OCR_TEXT_MIN = 32;

export interface ExtractResult {
  text: string;
  sourceType: "text" | "ocr";
}

const ALLOWED = new Set([".docx", ".pdf"]);

export async function extractText(fileName: string, buf: Buffer): Promise<ExtractResult> {
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED.has(ext)) {
    throw new Error("暂不支持该文件类型，请上传 .docx 或 .pdf（老式 .doc 请先另存为 .docx）");
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value.trim(), sourceType: "text" };
  }
  // .pdf
  const pdfText = await extractPdfText(buf);
  if (pdfText.trim().length >= OCR_TEXT_MIN) {
    return { text: pdfText.trim(), sourceType: "text" };
  }
  const ocrText = await ocrPdf(buf);
  const text = (pdfText.trim() || ocrText.trim()).trim();
  return { text, sourceType: text === ocrText.trim() && ocrText.trim() ? "ocr" : "text" };
}

// ------ pdfjs 加载（Node/ESM：legacy build + 显式 workerSrc） ------
let _workerReady = false;
let _pkgResolved: { workerSrc: string; standardFontDataUrl: string } | null = null;
function pkgPaths() {
  if (!_pkgResolved) {
    const pkgDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const workerSrc = pathToFileURL(path.join(pkgDir, "legacy/build/pdf.worker.mjs")).href;
    const standardFontDataUrl = pathToFileURL(path.join(pkgDir, "standard_fonts")).href + "/";
    _pkgResolved = { workerSrc, standardFontDataUrl };
  }
  return _pkgResolved;
}
async function loadPdfModule() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (!_workerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = pkgPaths().workerSrc;
    _workerReady = true;
  }
  return pdfjs;
}

interface LoadedDoc {
  doc: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
  destroy: () => Promise<void>;
}

async function loadDocument(buf: Buffer): Promise<LoadedDoc> {
  const pdfjs = await loadPdfModule();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    standardFontDataUrl: pkgPaths().standardFontDataUrl,
  });
  const doc = await task.promise;
  return {
    doc,
    destroy: () => task.destroy().then(() => undefined).catch(() => undefined),
  };
}

// 文字型 PDF：逐页取文本
async function extractPdfText(buf: Buffer): Promise<string> {
  const { doc, destroy } = await loadDocument(buf);
  const parts: string[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const line = content.items.map((it) => it.str).join(" ");
      parts.push(line);
    }
  } finally {
    await destroy();
  }
  return parts.join("\n");
}

// 扫描件 PDF：逐页渲染成图片 → 调 Python rapidocr
async function ocrPdf(buf: Buffer): Promise<string> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { doc, destroy } = await loadDocument(buf);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-ocr-"));
  const pngs: string[] = [];
  const SCALE = 2; // 提高 OCR 分辨率
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = createCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const p = path.join(tmpDir, `page-${i}.png`);
      fs.writeFileSync(p, canvas.toBuffer("image/png"));
      pngs.push(p);
    }
  } finally {
    await destroy();
  }
  try {
    const { runOcr } = await import("./ocripy.js");
    const res = runOcr(pngs);
    return res.ok ? res.text.trim() : "";
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
}