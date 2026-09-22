import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { renderDocx } from "../export/docx.js";
import { renderPdf } from "../export/pdf.js";
import type { ResumeContent } from "@resume-agent/shared";

export async function exportModule(app: FastifyInstance) {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id, format } = request.params as { id: string; format: "docx" | "pdf" };
    if (format !== "docx" && format !== "pdf") {
      return reply.code(400).send({ error: "不支持的格式" });
    }
    const resume = await app.prisma.resume.findFirst({ where: { id, userId: request.userId } });
    if (!resume) return reply.code(404).send({ error: "简历不存在" });

    const content = resume.content as unknown as ResumeContent;
    const safeName = (resume.title || "resume").replace(/[\\/:*?"<>|]/g, "_");
    const asciiName = /^[A-Za-z0-9_\-.]+$/.test(safeName) ? `${safeName}.${format}` : `resume.${format}`;
    const encodedName = encodeURIComponent(`${safeName}.${format}`);
    const disposition = `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;

    // 预览上报的分页断点（块 id 列表）：导出端在这些块前插入硬分页，实现逐页一致。
    // GET（无 body，如旧链接）降级为空断点，仍走导出器自身的自动分页。
    const body = (request.body || {}) as { pageBreakIds?: string[] };
    const pageBreakIds = Array.isArray(body.pageBreakIds) ? body.pageBreakIds : [];

    if (format === "docx") {
      const buf = await renderDocx(content, resume.templateId, pageBreakIds);
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      reply.header("Content-Disposition", disposition);
      return reply.send(buf);
    } else {
      const buf = await renderPdf(content, resume.templateId, pageBreakIds);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", disposition);
      return reply.send(buf);
    }
  };

  // POST 携带分页断点为主；保留 GET 兼容无断点场景
  app.post("/export/:id/:format", handler);
  app.get("/export/:id/:format", handler);
}
