// LLM 封装：兼容 OpenAI / DeepSeek / 豆包 / 通义 / 本地模型（Ollama、LM Studio、vLLM 等 OpenAI 兼容协议）
// 配置优先级：运行时 setRuntimeConfig（/ai/analyze 单次覆盖）> 激活的 profile（DB 内存快照）> .env > 默认值

export type LLMProvider = "openai" | "deepseek" | "doubao" | "qwen" | "ollama" | "lmstudio" | "vllm";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string; // 本地模型可能为空字符串
  baseUrl: string;
  model: string;
  maxContext: number; // 输入上下文上限（token）
  maxOutput: number; // 输出上限（token）
}

// 各家默认 base URL / model / 上下文与输出上限
const DEFAULTS: Record<LLMProvider, { baseUrl: string; model: string; maxContext: number; maxOutput: number }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", maxContext: 128000, maxOutput: 16384 },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", maxContext: 128000, maxOutput: 8192 },
  doubao: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-4k", maxContext: 128000, maxOutput: 8192 },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", maxContext: 131072, maxOutput: 8192 },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", maxContext: 32768, maxOutput: 4096 },
  lmstudio: { baseUrl: "http://localhost:1234/v1", model: "qwen2.5-7b", maxContext: 32768, maxOutput: 4096 },
  vllm: { baseUrl: "http://localhost:8000/v1", model: "qwen2.5-7b", maxContext: 32768, maxOutput: 4096 },
};

let _runtimeConfig: Partial<LLMConfig> | null = null; // 运行时覆盖（来自 /ai/analyze 单次请求）
let _envConfig: LLMConfig | null | undefined; // 缓存 .env 解析结果

// ---------------------------------------------------------------------------
// 多模型（Profiles）内存快照
// 持久化在数据库（aiModuleProfile 表，全局共享），由 ai 模块在启动与每次变更后
// 调用 refreshProfiles() 同步内存，getLLMConfig() 只读内存，保持同步调用链。
// ---------------------------------------------------------------------------

export interface LLMProfile {
  id: string;
  name: string;
  provider: LLMProvider;
  apiKey: string; // 本地模型可能为空字符串
  baseUrl: string;
  model: string;
  maxContext: number;
  maxOutput: number;
}

let _profiles: LLMProfile[] = [];
let _activeId: string | null = null;

/** 由上层（ai 模块）从数据库刷新内存快照 */
export function refreshProfiles(profiles: LLMProfile[], activeId: string | null) {
  _profiles = profiles.map((p) => ({ ...p }));
  _activeId = activeId;
}

export function listProfiles(): { profiles: LLMProfile[]; activeId: string | null } {
  return { profiles: _profiles.map((p) => ({ ...p })), activeId: _activeId };
}

/** 返回 provider 的默认 baseUrl / model，供持久化前兜底 */
export function defaultsFor(provider: LLMProvider): { baseUrl: string; model: string } {
  return DEFAULTS[provider];
}

function mergeAndValidate(base: LLMConfig): LLMConfig | null {
  // 基础配置 + 重新算默认 baseUrl / model / 上限
  const merged: LLMConfig = {
    provider: base.provider,
    apiKey: base.apiKey ?? "",
    baseUrl: base.baseUrl || DEFAULTS[base.provider].baseUrl,
    model: base.model || DEFAULTS[base.provider].model,
    maxContext: Math.max(1, base.maxContext || DEFAULTS[base.provider].maxContext),
    maxOutput: Math.max(1, base.maxOutput || DEFAULTS[base.provider].maxOutput),
  };
  // 云端需要 apiKey（本地模型可空）
  const isLocal = merged.provider === "ollama" || merged.provider === "lmstudio" || merged.provider === "vllm";
  if (!isLocal && !merged.apiKey) return null;
  return merged;
}

/**
 * 按 provider 构建 response_format。
 * - openai：支持结构化输出 json_schema。
 * - 其他云端（deepseek/doubao/qwen）：只支持 json_object（deepseek 用 json_schema 会报 400）。
 * - 本地模型：不支持该字段，由调用方走行内 JSON 提示。
 */
function buildResponseFormat(provider: LLMProvider, jsonSchema?: Record<string, unknown>) {
  if (!jsonSchema) return undefined;
  if (provider === "openai") {
    return { type: "json_schema", json_schema: { name: "resume_analysis", schema: jsonSchema, strict: true } };
  }
  return { type: "json_object" as const };
}

export function getLLMConfig(): LLMConfig | null {
  // 惰性解析 .env
  if (_envConfig === undefined) {
    const provider = (process.env.LLM_PROVIDER || "deepseek") as LLMProvider;
    const apiKey = process.env.LLM_API_KEY?.trim();
    const baseUrl = process.env.LLM_BASE_URL?.trim() || DEFAULTS[provider].baseUrl;
    const model = process.env.LLM_MODEL?.trim() || DEFAULTS[provider].model;
    const isLocal = provider === "ollama" || provider === "lmstudio" || provider === "vllm";
    if (!isLocal && !apiKey) {
      _envConfig = null;
    } else {
      _envConfig = {
        provider,
        apiKey: apiKey ?? "",
        baseUrl,
        model,
        maxContext: DEFAULTS[provider].maxContext,
        maxOutput: DEFAULTS[provider].maxOutput,
      };
    }
  }
  // 1) 运行时覆盖（/ai/analyze 单次请求）最高优先；若不可用则继续往下
  if (_runtimeConfig) {
    const cfg = mergeAndValidate({ ..._envConfig, ..._runtimeConfig } as LLMConfig);
    if (cfg) return cfg;
  }
  // 2) 激活的 profile（DB 内存快照）优先于 .env
  const active = _profiles.find((p) => p.id === _activeId);
  if (active) return mergeAndValidate(active);
  // 3) 回退 .env（未配置则 null）
  if (!_envConfig) return null;
  return mergeAndValidate(_envConfig);
}

export function isLLMAvailable(): boolean {
  return getLLMConfig() !== null;
}

/** 设置运行时覆盖配置（仅 /ai/analyze 单次覆盖使用，不落库） */
export function setRuntimeConfig(partial: Partial<LLMConfig> | null) {
  _runtimeConfig = partial;
}

/** 清空运行时覆盖 */
export function resetRuntimeConfig() {
  _runtimeConfig = null;
}

export function getDefaultConfig(): LLMConfig {
  // 给前端展示"当前生效"的配置（不暴露 apiKey 完整值）
  const cfg = getLLMConfig();
  if (!cfg) {
    // 返回一个 ollama 预设让前端有东西可展示
    return { provider: "ollama", apiKey: "", baseUrl: DEFAULTS.ollama.baseUrl, model: DEFAULTS.ollama.model, maxContext: DEFAULTS.ollama.maxContext, maxOutput: DEFAULTS.ollama.maxOutput };
  }
  return cfg;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  usage?: { prompt: number; completion: number };
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<ChatResult | null> {
  const cfg = getLLMConfig();
  if (!cfg) return null;

  const isLocal = cfg.provider === "ollama" || cfg.provider === "lmstudio" || cfg.provider === "vllm";
  const DEFAULT_MAX_TOKENS = isLocal ? 4000 : 2000;

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.3,
  };
  // 以 profile.maxOutput 作为真实上限收敛：调用方给的再大也被 clamp 到该模型输出上限
  body.max_tokens = Math.min(opts.maxTokens ?? DEFAULT_MAX_TOKENS, cfg.maxOutput);

  if (opts.jsonSchema) {
    if (!isLocal) {
      body.response_format = buildResponseFormat(cfg.provider, opts.jsonSchema);
    } else {
      body.messages = [
        { role: "system", content: "你必须严格输出 JSON，不要加任何其他文字、解释或 markdown 代码块。" },
        ...messages,
      ];
    }
  }

  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[LLM] ${cfg.provider} 请求失败 ${res.status}: ${txt}`);
      return null;
    }
    const data = (await res.json()) as any;
    const text: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.message?.reasoning_content ??
      data?.choices?.[0]?.message?.reasoning ??
      "";

    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    return {
      text: cleaned,
      usage: data?.usage
        ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
        : undefined,
    };
  } catch (err) {
    console.error("[LLM] 网络异常:", err);
    return null;
  }
}

/**
 * 流式版本：SSE 逐字接收 chat/completions。
 * - reasoning delta（思考过程）通过 onReasoning 实时回调，供前端逐字展示
 * - content delta 累加后以返回值返回（最终正式答案全文）
 * 返回最终 content 文本；调用失败返回 null。chat() 保持不变，此函数与之并行。
 */
export async function chatStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
  onReasoning?: (delta: string) => void,
  onContent?: (delta: string) => void
): Promise<string | null> {
  const cfg = getLLMConfig();
  if (!cfg) return null;

  const isLocal = cfg.provider === "ollama" || cfg.provider === "lmstudio" || cfg.provider === "vllm";

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.3,
  };
  // 流式 + 推理模型 reasoning 占用 token，给足 maxTokens 避免 JSON 被截断
  // 同时以 profile.maxOutput 作为真实上限收敛，避免超过各家硬上限
  body.max_tokens = Math.min(opts.maxTokens ?? 6000, cfg.maxOutput);
  body.stream = true;

  if (opts.jsonSchema) {
    if (!isLocal) {
      body.response_format = buildResponseFormat(cfg.provider, opts.jsonSchema);
    } else {
      body.messages = [
        { role: "system", content: "你必须严格输出 JSON，不要加任何其他文字、解释或 markdown 代码块。" },
        ...messages,
      ];
    }
  }

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[LLM] 流式网络异常:", err);
    return null;
  }
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    console.error(`[LLM] ${cfg.provider} 流式请求失败 ${res.status}: ${txt}`);
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accum = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
        if (!line || line === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }
        const delta = chunk?.choices?.[0]?.delta ?? {};
        const reasoning = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoning === "string" && reasoning) onReasoning?.(reasoning);
        if (typeof delta?.content === "string" && delta.content) {
          accum += delta.content;
          onContent?.(delta.content);
        }
      }
    }
  } catch (err) {
    console.error("[LLM] 流式读取异常:", err);
    return null;
  }

  return accum.trim();
}

export function parseJSON<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
