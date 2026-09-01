import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

async function prismaPlugin(app: FastifyInstance) {
  const prisma = new PrismaClient();
  await prisma.$connect();
  app.decorate("prisma", prisma);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
}

export default fp(prismaPlugin);
