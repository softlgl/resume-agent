// 对话历史的读取与裁剪 —— Node 与 .NET 的唯一实现（两边同构，禁止出现第三份）
//
// 三类读取，别混用：
// - A 视图 getHistoryForLLM：喂给 LLM 的历史消息（角色归一 + 单条截断 + 尾部按预算累积）
// - B 视图 getRecentUserText：用户原话（仅 user 角色 + 本条），供事实核验与时间抽取
// - C 读取（不走本文件）：面试要读 assistant 的 meta.probeDepth / meta.dimension，
//   截断会丢依据，因此按 orderBy createdAt asc 直读原始行，本文件只固化这个排序约定
// 未来若做摘要压缩：只替换 getHistoryForLLM 的函数体，签名保持不变。

import type { ChatMessage } from "./llm.js";
import { getLLMConfig } from "./llm.js";

export const HISTORY_MAX_COUNT = 12; // 最多带最近 12 条历史
export const HISTORY_MSG_MAX_CHARS = 2000; // 单条历史消息字符上限

export interface HistoryRow {
  role: string;
  content: string;
}

/** 按 LLM 上下文预算推算可用于历史的字符数（简历 JSON 压缩也复用本函数） */
export function contextCharBudget(): number {
  const cfg = getLLMConfig();
  // maxContext 是 token 数；中文约 1 token/字，留 45% 给历史并按 1.5 倍保守放大
  const maxContext = cfg?.maxContext ?? 32768;
  return Math.floor(maxContext * 0.45 * 1.5);
}

/** A 视图：最近 HISTORY_MAX_COUNT 条内，单条截断，再从最新往回累积到预算为止 */
export function getHistoryForLLM(rows: HistoryRow[], maxChars: number): ChatMessage[] {
  const recent = rows.slice(-HISTORY_MAX_COUNT);
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    const c =
      r.content.length > HISTORY_MSG_MAX_CHARS
        ? `${r.content.slice(0, HISTORY_MSG_MAX_CHARS)}…（已截断）`
        : r.content;
    if (out.length > 0 && used + c.length > maxChars) break;
    out.unshift({ role: r.role === "assistant" ? "assistant" : "user", content: c });
    used += c.length;
  }
  return out;
}

/**
 * B 视图：用户最近说过的话（仅 user 角色，含本条）。
 * 事实核验与时间抽取都只认用户自己的话——AI 回复里天然带大量日期，
 * 混进来会让「哪段日期属于本条经历」的判断失真。
 */
export function getRecentUserText(rows: HistoryRow[], currentText: string): string {
  return [
    ...rows
      .slice(-HISTORY_MAX_COUNT)
      .filter((r) => r.role === "user")
      .map((r) => r.content),
    currentText,
  ].join("\n");
}