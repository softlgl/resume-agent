import type { FastifyInstance } from "fastify";
import { renderDocx } from "../export/docx.js";
import { renderPdf } from "../export/pdf.js";
import type { ResumeContent } from "@resume-agent/shared";

export async function exportModule(app: FastifyInstance) {
  app.get("/export/:id/:format", async (request, reply) => {
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

    if (format === "docx") {
      const buf = await renderDocx(content, resume.templateId);
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      reply.header("Content-Disposition", disposition);
      return reply.send(buf);
    } else {
      const buf = await renderPdf(content, resume.templateId);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", disposition);
      return reply.send(buf);
    }
  });
}
