// AI 配置模块：模型 profiles 的增删改选 + 内存快照同步 + 调用日志查询（对齐 .NET 的 AiConfigEndpoints）
// 路由：POST /ai/config、GET /ai/config、DELETE /ai/config、GET /ai/health、GET /ai/calls/latest

import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  getDefaultConfig,
  isLLMAvailable,
  listProfiles,
  refreshProfiles,
  defaultsFor,
} from "./core/llm.js";
import type { LLMProfile, LLMConfig, LLMProvider, ThinkingMode } from "./core/llm.js";

function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}***${key.slice(-2)}`;
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

/** 思考开关取值归一：只接受 on/off，其余（含 undefined 与旧数据）一律回落 follow */
function normalizeThinkingMode(v: unknown): ThinkingMode {
  return v === "on" || v === "off" ? v : "follow";
}

/** 从数据库读取模型配置并刷新 llm 模块内存快照（全局共享，无 userId） */
export async function syncProfiles(prisma: PrismaClient) {
  // 首次启动且尚无任何模型记录时，把 .env/默认值种入一条默认模型并置为激活，
  // 保证前端模型列表始终有可见、可用的默认模型（后续仍可正常编辑/删除/新增）
  const count = await prisma.aiModelProfile.count();
  if (count === 0) {
    const seed = getDefaultConfig();
    await prisma.aiModelProfile.create({
      data: {
        name: "默认模型",
        provider: seed.provider,
        apiKey: seed.apiKey,
        baseUrl: seed.baseUrl,
        model: seed.model,
        maxContext: seed.maxContext,
        maxOutput: seed.maxOutput,
        thinkingMode: normalizeThinkingMode(seed.thinkingMode),
        active: true,
      },
    });
  }
  const rows = await prisma.aiModelProfile.findMany({ orderBy: { createdAt: "asc" } });
  const profiles: LLMProfile[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    provider: r.provider as LLMProfile["provider"],
    apiKey: r.apiKey,
    baseUrl: r.baseUrl,
    model: r.model,
    maxContext: r.maxContext,
    maxOutput: r.maxOutput,
    thinkingMode: normalizeThinkingMode(r.thinkingMode),
  }));
  refreshProfiles(profiles, rows.find((r) => r.active)?.id ?? null);
}

function buildConfigPayload(profiles: LLMProfile[], activeId: string | null, cfg: LLMConfig) {
  return {
    profiles: profiles.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      maxContext: p.maxContext,
      maxOutput: p.maxOutput,
      thinkingMode: normalizeThinkingMode(p.thinkingMode),
      apiKeyMasked: maskApiKey(p.apiKey),
      active: p.id === activeId,
    })),
    activeId,
    // 当前生效配置摘要（可能来自 .env 或激活的 profile）
    config: {
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKeyMasked: maskApiKey(cfg.apiKey),
    },
    available: isLLMAvailable(),
  };
}

export async function aiConfigModule(app: FastifyInstance) {
  // 最近一次 AI 调用日志（供前端展示，数据保留全量历史）
  app.get("/ai/calls/latest", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const row = await app.prisma.llmCallLog.findFirst({
      where: { userId: request.userId },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return { call: null };
    return {
      call: {
        id: row.id,
        kind: row.kind,
        resumeId: row.resumeId,
        provider: row.provider,
        model: row.model,
        ok: row.ok,
        reasoning: row.reasoning,
        output: row.output,
        createdAt: row.createdAt.toISOString(),
      },
    };
  });

  // 健康检查
  app.get("/ai/health", async () => ({
    llmAvailable: isLLMAvailable(),
    config: getDefaultConfig(),
  }));

  // 获取配置列表（模型 profiles + 当前激活）+ 当前生效配置摘要（前端初始化设置面板）
  app.get("/ai/config", async () => {
    await syncProfiles(app.prisma);
    const { profiles, activeId } = listProfiles();
    return buildConfigPayload(profiles, activeId, getDefaultConfig());
  });

  // 增删改选模型 profile：body { action: 'add'|'update'|'remove'|'setActive'|'clear', ... }
  app.post("/ai/config", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    const body = (request.body ?? {}) as any;
    const action = typeof body?.action === "string" ? body.action : "add";
    const prisma = app.prisma;
    switch (action) {
      case "add": {
        if (!body?.provider) return reply.code(400).send({ error: "provider 必填" });
        const provider = body.provider as LLMProvider;
        const def = defaultsFor(provider);
        const count = await prisma.aiModelProfile.count();
        await prisma.aiModelProfile.create({
          data: {
            name: body.name?.trim() || (body.model?.trim() ? `${provider} · ${body.model.trim()}` : provider),
            provider,
            apiKey: body.apiKey ?? "",
            baseUrl: body.baseUrl?.trim() || def.baseUrl,
            model: body.model?.trim() || def.model,
            maxContext: body.maxContext ?? def.maxContext,
            maxOutput: body.maxOutput ?? def.maxOutput,
            thinkingMode: normalizeThinkingMode(body.thinkingMode),
            active: count === 0, // 第一条自动激活
          },
        });
        break;
      }
      case "update": {
        if (!body?.id) return reply.code(400).send({ error: "id 必填" });
        const t = await prisma.aiModelProfile.findUnique({ where: { id: body.id } });
        if (!t) return reply.code(404).send({ error: "模型不存在" });
        const provider = (body.provider as LLMProvider) || (t.provider as LLMProvider);
        const def = defaultsFor(provider);
        await prisma.aiModelProfile.update({
          where: { id: body.id },
          data: {
            name: body.name?.trim() || t.name,
            provider,
            apiKey: body.apiKey !== undefined ? body.apiKey : t.apiKey,
            baseUrl: body.baseUrl?.trim() || (body.baseUrl !== undefined ? def.baseUrl : t.baseUrl),
            model: body.model?.trim() || (body.model !== undefined ? def.model : t.model),
            maxContext: body.maxContext !== undefined ? body.maxContext : t.maxContext,
            maxOutput: body.maxOutput !== undefined ? body.maxOutput : t.maxOutput,
            thinkingMode: body.thinkingMode !== undefined ? normalizeThinkingMode(body.thinkingMode) : t.thinkingMode,
          },
        });
        break;
      }
      case "remove": {
        if (!body?.id) return reply.code(400).send({ error: "id 必填" });
        const t = await prisma.aiModelProfile.findUnique({ where: { id: body.id } });
        if (!t) return reply.code(404).send({ error: "模型不存在" });
        await prisma.aiModelProfile.delete({ where: { id: body.id } });
        // 删除激活项时让第一条成为新的激活
        if (t.active) {
          const next = await prisma.aiModelProfile.findFirst({ orderBy: { createdAt: "asc" } });
          if (next) await prisma.aiModelProfile.update({ where: { id: next.id }, data: { active: true } });
        }
        break;
      }
      case "setActive": {
        if (!body?.id) return reply.code(400).send({ error: "id 必填" });
        const t = await prisma.aiModelProfile.findUnique({ where: { id: body.id } });
        if (!t) return reply.code(404).send({ error: "模型不存在" });
        await prisma.$transaction([
          prisma.aiModelProfile.updateMany({ where: { active: true }, data: { active: false } }),
          prisma.aiModelProfile.update({ where: { id: body.id }, data: { active: true } }),
        ]);
        break;
      }
      case "clear": {
        await prisma.aiModelProfile.deleteMany({});
        break;
      }
      default:
        return reply.code(400).send({ error: `未知 action: ${action}` });
    }
    await syncProfiles(prisma);
    const cur = listProfiles();
    return buildConfigPayload(cur.profiles, cur.activeId, getDefaultConfig());
  });

  // 清空所有模型 profile（回到 .env 逻辑）
  app.delete("/ai/config", async (request, reply) => {
    if (!request.userId) return reply.code(401).send({ error: "未登录" });
    await app.prisma.aiModelProfile.deleteMany({});
    await syncProfiles(app.prisma);
    const cur = listProfiles();
    return buildConfigPayload(cur.profiles, cur.activeId, getDefaultConfig());
  });
}