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
};
