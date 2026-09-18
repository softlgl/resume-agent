const TOKEN_KEY = "resume_agent_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) || {}),
  };
  // 只有带 body 的请求才设 Content-Type，避免 Fastify 对空 body 报 FST_ERR_CTP_EMPTY_JSON_BODY
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  register: (username: string, password: string) =>
    request<{ token: string; username: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request<{ token: string; username: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<{ username: string }>("/auth/me"),

  listResumes: () => request<{ resumes: any[] }>("/resumes"),
  getResume: (id: string) => request<{ resume: any }>(`/resumes/${id}`),
  createResume: (data: any) =>
    request<{ resume: any }>("/resumes", { method: "POST", body: JSON.stringify(data) }),
  updateResume: (id: string, data: any) =>
    request<{ resume: any }>(`/resumes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteResume: (id: string) => request<{ ok: true }>(`/resumes/${id}`, { method: "DELETE" }),

  exportUrl: (id: string, format: "docx" | "pdf") => `/export/${id}/${format}`,

  // ---- 导入 Word/PDF ----
  // 不同于 request()（会给带 body 的请求强制 application/json，与 FormData 冲突），
  // 这里直接用 fetch 传 FormData，让浏览器自带头 boundary。
  importResume: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch("/import/parse", { method: "POST", headers, body: fd });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `导入失败 (${res.status})`);
    }
    return res.json() as Promise<{
      fileName: string;
      sourceText: string;
      ocrUsed: boolean;
      content: any | null;
      note?: string;
    }>;
  },

  // ---- AI 分析 ----
  analyzeResume: (data: { content: any; resumeId?: string; jd?: string; force?: boolean }) =>
    request<{ analysis: any }>("/ai/analyze", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  // LLM 配置
  aiHealth: () => request<{ llmAvailable: boolean; provider: string | null; config?: any }>("/ai/health"),
  aiGetConfig: () => request<{ provider: string; baseUrl: string; model: string; apiKeyMasked: string }>("/ai/config"),
  aiSetConfig: (cfg: { provider?: string; baseUrl?: string; model?: string; apiKey?: string }) =>
    request<{ ok: boolean; available: boolean; config: any }>("/ai/config", {
      method: "POST",
      body: JSON.stringify(cfg),
    }),
  aiResetConfig: () => request<{ ok: boolean; available: boolean; config: any }>("/ai/config", { method: "DELETE" }),

  // ---- 流式（SSE）版本：逐字接收 LLM 思考过程 ----
  analyzeResumeStream: (
    data: { content: any; resumeId?: string; jd?: string; force?: boolean },
    onReasoning: (delta: string) => void,
    onContent?: (delta: string) => void
  ) =>
    consumeSSEFetch<{ analysis: any }>(
      "/ai/analyze",
      JSON.stringify({ ...data, streaming: true }),
      onReasoning,
      onContent
    ),

  importResumeStream: (file: File, onReasoning: (delta: string) => void, onContent?: (delta: string) => void) => {
    const fd = new FormData();
    fd.append("file", file);
    return consumeSSEFetch<{
      fileName: string;
      sourceText: string;
      ocrUsed: boolean;
      content: any | null;
      note?: string;
    }>("/import/parse", fd, onReasoning, onContent, true);
  },

  // 标记分析结果中某条建议为「已应用」（落库到 Resume.analysis）
  markIssueApplied: (resumeId: string, section: string, index: number) =>
    request<{ ok: boolean }>(`/ai/analyze/${resumeId}/applied`, {
      method: "PATCH",
      body: JSON.stringify({ section, index }),
    }),
};

// 解析 SSE(fetch stream)：按 \n\n 切块，读 event/data，reasoning/content → 回调，result 事件 resolve
async function consumeSSEFetch<T>(
  path: string,
  body: BodyInit,
  onReasoning: (delta: string) => void,
  onContent?: (delta: string) => void,
  isFormData = false
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (!isFormData) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { method: "POST", headers, body });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let resolved: T | undefined;
  let resolveFn!: (v: T) => void;
  let rejectFn!: (e: Error) => void;

  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const failSafe = (e: Error) => rejectFn(e);

  (async () => {
    try {
      while (true) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const evt = p.match(/^event: (\S+)/m)?.[1];
          const dm = p.match(/^data: (.*)$/m)?.[1];
          if (!dm) continue;
          try {
            const data = JSON.parse(dm);
            if (evt === "reasoning" && typeof data.delta === "string") onReasoning(data.delta);
            else if (evt === "content" && typeof data.delta === "string") onContent?.(data.delta);
            else if (evt === "result") resolved = data as T;
            else if (evt === "error") failSafe(new Error(data.message || "处理失败"));
          } catch {
            /* 忽略无法解析的块 */
          }
        }
      }
      if (resolved === undefined) failSafe(new Error("未收到结果"));
      else resolveFn(resolved);
    } catch (e: any) {
      failSafe(e);
    }
  })();

  return promise;
}
