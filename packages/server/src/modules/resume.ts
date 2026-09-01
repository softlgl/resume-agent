import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ResumeContent } from "@resume-agent/shared";

const saveSchema = z.object({
  title: z.string().min(1).max(80),
  templateId: z.string().min(1),
  content: z.any() as unknown as z.ZodType<ResumeContent>,
});

export async function resumeModule(app: FastifyInstance) {
  // 列表
  app.get("/resumes", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const list = await app.prisma.resume.findMany({
      where: { userId: request.userId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, templateId: true, updatedAt: true },
    });
    return { resumes: list };
  });

  // 详情
  app.get("/resumes/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const resume = await app.prisma.resume.findFirst({ where: { id, userId: request.userId } });
    if (!resume) return reply.code(404).send({ error: "简历不存在" });
    return { resume };
  });

  // 新建
  app.post("/resumes", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const parsed = saveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "数据格式不正确" });
    const resume = await app.prisma.resume.create({
      data: {
        userId: request.userId,
        title: parsed.data.title,
        templateId: parsed.data.templateId,
        content: parsed.data.content as any,
      },
    });
    return { resume };
  });

  // 更新
  app.put("/resumes/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const parsed = saveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "数据格式不正确" });
    const existing = await app.prisma.resume.findFirst({ where: { id, userId: request.userId } });
    if (!existing) return reply.code(404).send({ error: "简历不存在" });
    const resume = await app.prisma.resume.update({
      where: { id },
      data: {
        title: parsed.data.title,
        templateId: parsed.data.templateId,
        content: parsed.data.content as any,
      },
    });
    return { resume };
  });

  // 删除
  app.delete("/resumes/:id", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const { id } = request.params as { id: string };
    const existing = await app.prisma.resume.findFirst({ where: { id, userId: request.userId } });
    if (!existing) return reply.code(404).send({ error: "简历不存在" });
    await app.prisma.resume.delete({ where: { id } });
    return { ok: true };
  });
}
