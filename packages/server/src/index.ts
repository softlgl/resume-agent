import Fastify from "fastify";
import cors from "@fastify/cors";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import { authModule } from "./modules/auth.js";
import { resumeModule } from "./modules/resume.js";
import { exportModule } from "./modules/export.js";
import { aiModule } from "./modules/ai.js";
import { aiChatModule } from "./modules/ai-chat.js";
import { importModule } from "./modules/import.js";

const app = Fastify({ logger: true });

async function main() {
  await app.register(cors, {
    origin: (process.env.CLIENT_ORIGIN || "http://localhost:5173").split(","),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  await app.register(authModule);
  await app.register(resumeModule);
  await app.register(exportModule);
  await app.register(aiModule);
  await app.register(aiChatModule);
  await app.register(importModule);

  app.get("/health", async () => ({ ok: true }));

  const port = Number(process.env.PORT || 4000);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`Server listening on http://localhost:${port}`);
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
