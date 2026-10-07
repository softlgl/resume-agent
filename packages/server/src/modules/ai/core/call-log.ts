// LLM 调用日志（统一出口）
// 分析侧与对话侧共用；导入侧因需按「是否解析成功」写 ok，另有自己的写入分支。

import type { PrismaClient } from "@prisma/client";
import { getDefaultConfig } from "./llm.js";

/** 记录一次 AI 调用日志（保留全部历史，前端只展示最新一条） */
export async function recordCall(
  prisma: PrismaClient,
  userId: string,
  result: { reasoning?: string | null; output?: string | null },
  opts: { kind?: "analyze" | "import" | "chat"; resumeId?: string | null } = {}
) {
  try {
    const cfg = getDefaultConfig();
    await prisma.llmCallLog.create({
      data: {
        userId,
        kind: opts.kind ?? "analyze",
        resumeId: opts.resumeId ?? null,
        provider: cfg.provider,
        model: cfg.model,
        ok: true,
        reasoning: result.reasoning ?? null,
        output: result.output ?? null,
      },
    });
  } catch (err) {
    console.error("[AI] 记录调用日志失败:", err);
  }
}