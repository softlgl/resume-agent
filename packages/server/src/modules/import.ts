import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { extractText } from "../services/extract.js";
import { structurizeText } from "../services/structurize.js";
import { extractSensitive, redactText, restoreSensitive } from "../services/redact.js";
import { getDefaultConfig } from "../services/llm.js";

export async function importModule(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  // 导入解析：上传 .docx/.pdf → 抽取文本(扫描件走 OCR) → LLM 结构化 → SSE 流式返回
  // 流式输出：status(提取完成) → reasoning(结构化思考过程,逐字) → result(最终结构) / error
  app.post("/import/parse", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });

    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "未收到文件" });
    const fileName = file.filename || "resume";

    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.code(400).send({ error: "读取文件失败" });
    }

    let extract;
    try {
      extract = await extractText(fileName, buf);
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message || "解析文件失败" });
    }

    // 文件解析完成，切换为 SSE 流
    reply.hijack();
    const raw = reply.raw;
    raw.setHeader("Content-Type", "text/event-stream");
    raw.setHeader("Cache-Control", "no-cache");
    raw.setHeader("Connection", "keep-alive");
    const send = (event: string, data: unknown) =>
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send("status", { message: "文本已提取，正在识别…" });

    // 敏感信息本地抽取并在发往 LLM 前替换为占位（避免姓名/电话/邮箱/地址外发）；AI 完成后回填真值
    const sensitive = extractSensitive(extract.text);
    // 所在地无明确标签时启发式不可靠：不本地回填也不脱敏，交由 LLM 推断，避免错值覆盖
    if (!sensitive.locationReliable) sensitive.location = "";
    const sendText = redactText(extract.text, sensitive);

    let content = null;
    let note: string | undefined;
    let importReasoning = "";
    let importOutput = "";
    try {
      content = await structurizeText(
        sendText,
        (d) => { importReasoning += d; send("reasoning", { delta: d }); },
        (d) => { importOutput += d; send("content", { delta: d }); }
      );
    } catch {
      content = null;
    }
    if (!content) {
      note = "未配置 LLM 或自动识别失败，文本已提取，请手动填写。";
    } else {
      // 归一：项目所属公司尽量匹配到工作经历里的公司名（模糊/包含），不中则留空
      const companies = content.works.map((w) => w.company.trim()).filter(Boolean);
      const fit = (candidate: string): string => {
        const t = candidate.trim();
        if (!t || companies.length === 0) return "";
        const lower = t.toLowerCase();
        const hit = companies.find((c) => c.toLowerCase() === lower);
        if (hit) return hit;
        const contain = companies.find((c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
        return contain || "";
      };
      content.projects = content.projects.map((p) => ({ ...p, company: fit(p.company) }));
      // 敏感信息回填：用本地抽取的真实值覆盖 basic（地址→location；未抽到的字段保持 AI 结果）
      restoreSensitive(content, sensitive);
    }

    // 记录一次【导入】调用日志（按 userId，无简历 id）
    try {
      const cfg = getDefaultConfig();
      await app.prisma.llmCallLog.create({
        data: {
          userId: request.userId,
          kind: "import",
          provider: cfg.provider,
          model: cfg.model,
          ok: content !== null,
          reasoning: importReasoning || null,
          output: content ? JSON.stringify(content) : importOutput || null,
        },
      });
    } catch (err) {
      console.error("[IMPORT] 记录调用日志失败:", err);
    }

    send("result", {
      fileName,
      sourceText: extract.text,
      ocrUsed: extract.sourceType === "ocr",
      content,
      note,
    });
    send("done", { ok: true });
    raw.end();
    return reply;
  });
}