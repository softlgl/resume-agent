import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { extractText } from "../services/extract.js";
import { structurizeText } from "../services/structurize.js";

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

    let content = null;
    let note: string | undefined;
    try {
      content = await structurizeText(
        extract.text,
        (d) => send("reasoning", { delta: d }),
        (d) => send("content", { delta: d })
      );
    } catch {
      content = null;
    }
    if (!content) {
      note = "未配置 LLM 或自动识别失败，文本已提取，请手动填写。";
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