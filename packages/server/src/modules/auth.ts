import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { signToken } from "../plugins/auth.js";

const authSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(6).max(64),
});

export async function authModule(app: FastifyInstance) {
  // 注册
  app.post("/auth/register", async (request, reply) => {
    const parsed = authSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "用户名 3-32 位，密码 6-64 位" });
    }
    const { username, password } = parsed.data;
    const exists = await app.prisma.user.findUnique({ where: { username } });
    if (exists) {
      return reply.code(409).send({ error: "用户名已存在" });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await app.prisma.user.create({ data: { username, password: hash } });
    const token = signToken(user.id);
    return { token, username: user.username };
  });

  // 登录
  app.post("/auth/login", async (request, reply) => {
    const parsed = authSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "用户名或密码格式不正确" });
    }
    const { username, password } = parsed.data;
    const user = await app.prisma.user.findUnique({ where: { username } });
    if (!user) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    const token = signToken(user.id);
    return { token, username: user.username };
  });

  // 当前用户
  app.get("/auth/me", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const user = await app.prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) return reply.code(401).send({ error: "未登录" });
    return { username: user.username };
  });
}
