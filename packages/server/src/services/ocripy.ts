// OCR 封装：调 conda 虚拟环境里的官方 rapidocr(onnxruntime) 识别图片，返回聚合文本
// 流程：
//  1) 找到 conda（CONDA_EXE 或 PATH 中的 conda）
//  2) 若不存在虚拟环境(默认 resume_ocr)，则创建
//  3) 判断该环境里是否已装 rapidocr+onnxruntime（import 探测），未装则 pip 安装
//  4) 用该环境的 python 运行 scripts/ocr.py
// 已装通过后缓存 ready 标记，后续请求不再重复探测/安装。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "ocr.py"
);
const ENV_NAME = process.env.RESUME_OCR_ENV || "resume_ocr";

export interface OcrResult {
  ok: boolean;
  text: string;
  error?: string;
}

let _ready: "untried" | "ready" | "failed" = "untried";
let _lastError = "";

function condaBin(): string {
  return process.env.CONDA_EXE || "conda";
}

/** 在 conda 环境里执行命令（conda run -n <env> <cmd...>），返回 stdout 字符串 */
function condaRun(args: string[], timeout: number): string {
  return execFileSync(condaBin(), [...args], {
    encoding: "utf-8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 判断虚拟环境是否存在 */
function envExists(): boolean {
  try {
    condaRun(["env", "list"], 60000);
  } catch {
    return false;
  }
  try {
    condaRun(["run", "-n", ENV_NAME, "python", "--version"], 60000);
    return true;
  } catch {
    return false;
  }
}

/** 判断环境里是否已安装 rapidocr 与 onnxruntime */
function isInstalled(): boolean {
  try {
    condaRun(
      ["run", "-n", ENV_NAME, "python", "-c", "import rapidocr, onnxruntime"],
      60000
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次性准备 OCR 环境：建虚拟环境 → 按需安装依赖。
 * 返回 true 表示可用；失败时写入 _lastError。
 */
function ensureReady(): boolean {
  try {
    if (!envExists()) {
      condaRun(
        ["create", "-n", ENV_NAME, "python", "-y", "-q"],
        600000 // 创建环境可能下载 python，给足超时
      );
    }
    if (!isInstalled()) {
      condaRun(
        ["run", "-n", ENV_NAME, "python", "-m", "pip", "install", "-q", "rapidocr", "onnxruntime"],
        600000 // pip 安装/下载模型依赖可能较久
      );
    }
    _ready = "ready";
    return true;
  } catch (err: any) {
    _ready = "failed";
    _lastError = String(err?.message || err);
    return false;
  }
}

/** 调 python ocr.py <img1> <img2> ...，脚本 stdout 输出 JSON {"texts":[{pageIndex,text}]} */
export function runOcr(imagePaths: string[]): OcrResult {
  if (imagePaths.length === 0) return { ok: false, text: "" };

  if (_ready !== "ready") {
    if (_ready !== "failed" && !ensureReady()) {
      return { ok: false, text: "", error: _lastError };
    }
    if (_ready === "failed") {
      // 上次已失败过：说明环境一直不可用，别再反复耗时探测
      return { ok: false, text: "", error: _lastError };
    }
  }

  try {
    const stdout = condaRun(
      ["run", "-n", ENV_NAME, "python", SCRIPT_PATH, ...imagePaths],
      180000
    );
    // conda run 可能输出激活横幅，取出第一个 { 到最后一个 } 的 JSON
    const m = /^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/.exec(stdout.trim());
    const data = m
      ? (JSON.parse(m[1]) as { texts?: { pageIndex: number; text: string }[] })
      : null;
    if (!data || !Array.isArray(data.texts)) return { ok: false, text: "" };
    const ordered = [...data.texts]
      .sort((a, b) => a.pageIndex - b.pageIndex)
      .map((t) => t.text ?? "")
      .join("\n");
    return { ok: true, text: ordered };
  } catch (err: any) {
    return { ok: false, text: "", error: String(err?.message || err) };
  }
}