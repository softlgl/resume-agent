// LLM 封装：兼容 OpenAI / DeepSeek / 豆包 / 通义 / 本地模型（Ollama、LM Studio、vLLM 等 OpenAI 兼容协议）
// 配置优先级：前端覆盖 > 运行时 setRuntimeConfig > .env > 默认值

export type LLMProvider = "openai" | "deepseek" | "doubao" | "qwen" | "ollama" | "lmstudio" | "vllm";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string; // 本地模型可能为空字符串
  baseUrl: string;
  model: string;
}

// 各家默认 base URL 和 model
const DEFAULTS: Record<LLMProvider, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  doubao: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-pro-4k" },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", model: "qwen2.5-7b" },
  vllm: { baseUrl: "http://localhost:8000/v1", model: "qwen2.5-7b" },
};

let _runtimeConfig: Partial<LLMConfig> | null = null; // 运行时覆盖（前端传来）
let _envConfig: LLMConfig | null | undefined; // 缓存 .env 解析结果

export function getLLMConfig(): LLMConfig | null {
  // 先算 .env 基础配置
  if (_envConfig === undefined) {
    const provider = (process.env.LLM_PROVIDER || "deepseek") as LLMProvider;
    const apiKey = process.env.LLM_API_KEY?.trim();
    const baseUrl = process.env.LLM_BASE_URL?.trim() || DEFAULTS[provider].baseUrl;
    const model = process.env.LLM_MODEL?.trim() || DEFAULTS[provider].model;
    const isLocal = provider === "ollama" || provider === "lmstudio" || provider === "vllm";
    if (!isLocal && !apiKey) {
      _envConfig = null;
    } else {
      _envConfig = { provider, apiKey: apiKey ?? "", baseUrl, model };
    }
  }
  // 运行时覆盖 > .env
  const base = _runtimeConfig
    ? { ..._envConfig, ..._runtimeConfig } as LLMConfig
    : _envConfig;
  if (!base) return null;
  // 运行时覆盖可能改了 provider，重新算默认 baseUrl / model
  const merged: LLMConfig = {
    provider: base.provider,
    apiKey: base.apiKey ?? "",
    baseUrl: base.baseUrl || DEFAULTS[base.provider].baseUrl,
    model: base.model || DEFAULTS[base.provider].model,
  };
  // 云端需要 apiKey（运行时覆盖也强制检查）
  const isLocal = merged.provider === "ollama" || merged.provider === "lmstudio" || merged.provider === "vllm";
  if (!isLocal && !merged.apiKey) return null;
  return merged;
}

export function isLLMAvailable(): boolean {
  return getLLMConfig() !== null;
}

/** 设置运行时覆盖配置（来自前端面板） */
export function setRuntimeConfig(partial: Partial<LLMConfig> | null) {
  _runtimeConfig = partial;
}

/** 重置为仅使用 .env */
export function resetRuntimeConfig() {
  _runtimeConfig = null;
}

export function getDefaultConfig(): LLMConfig {
  // 给前端展示"当前生效"的配置（不暴露 apiKey 完整值）
  const cfg = getLLMConfig();
  if (!cfg) {
    // 返回一个 ollama 预设让前端有东西可展示
    return { provider: "ollama", apiKey: "", baseUrl: DEFAULTS.ollama.baseUrl, model: DEFAULTS.ollama.model };
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
  body.max_tokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (opts.jsonSchema) {
    if (!isLocal) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "resume_analysis", schema: opts.jsonSchema, strict: true },
      };
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
  body.max_tokens = opts.maxTokens ?? 6000;
  body.stream = true;

  if (opts.jsonSchema) {
    if (!isLocal) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "resume_analysis", schema: opts.jsonSchema, strict: true },
      };
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
