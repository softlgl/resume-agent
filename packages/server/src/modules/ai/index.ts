// AI 域入口（对齐 .NET 的 Endpoints/Ai/*）
// 职责：启动时同步模型配置到内存快照，再挂载各子模块。
// 对外契约不变：路由仍是 /ai/*、/import，JSON 仍 camelCase。

import type { FastifyInstance } from "fastify";
import { aiAnalyzeModule } from "./analyze.js";
import { aiConfigModule, syncProfiles } from "./config.js";
import { aiChatModule } from "./chat.js";
import { aiInterviewModule } from "./interview.js";
import { importModule } from "./import.js";

export async function aiModule(app: FastifyInstance) {
  // 启动时从数据库加载模型配置到内存快照。
  // 必须 await：否则冷启动期间 /ai/health、/ai/analyze 会拿到未就绪的配置。
  await syncProfiles(app.prisma);

  await app.register(aiAnalyzeModule);
  await app.register(aiConfigModule);
  await app.register(aiChatModule);
  await app.register(aiInterviewModule);
  await app.register(importModule);
}