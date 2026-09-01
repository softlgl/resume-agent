import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change_me_to_a_long_random_secret_string";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

// 签发 / 校验 token
export function signToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "7d" });
}

async function authPlugin(app: FastifyInstance) {
  app.decorateRequest("userId", "");
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // 保护需要登录态的路由：/resumes、/export 与 /auth/me
    if (
      !request.routeOptions.url?.startsWith("/resumes") &&
      !request.routeOptions.url?.startsWith("/export") &&
      !request.routeOptions.url?.startsWith("/auth/me")
    ) {
      return;
    }
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "未登录" });
    }
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET) as { userId: string };
      request.userId = payload.userId;
    } catch {
      return reply.code(401).send({ error: "登录已过期" });
    }
  });
}

export default fp(authPlugin);
