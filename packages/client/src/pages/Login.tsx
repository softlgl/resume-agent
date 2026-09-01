import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setToken } from "../api/client";

export default function Login() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = mode === "login" ? await api.login(username, password) : await api.register(username, password);
      setToken(res.token);
      navigate("/editor");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="glass rounded-3xl shadow-glass w-full max-w-md p-8">
        <h1 className="text-3xl font-bold text-center text-brand-700 mb-1">简历助手</h1>
        <p className="text-center text-slate-500 mb-6">填写信息 · 选择模板 · 导出 Word / PDF</p>

        <div className="flex gap-2 mb-6">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-xl text-sm font-semibold transition ${
                mode === m ? "bg-brand-600 text-white" : "bg-white/50 text-slate-600"
              }`}
            >
              {m === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="text-sm text-slate-600">用户名</span>
            <input
              className="w-full mt-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="3-32 位"
            />
          </label>
          <label className="block">
            <span className="text-sm text-slate-600">密码</span>
            <input
              type="password"
              className="w-full mt-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6-64 位"
            />
          </label>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700 transition disabled:opacity-60"
          >
            {loading ? "处理中…" : mode === "login" ? "登录" : "注册并进入"}
          </button>
        </form>
      </div>
    </div>
  );
}
