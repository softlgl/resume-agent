import { useEffect, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import Login from "./pages/Login";
import Editor from "./pages/Editor";
import { getToken, api } from "./api/client";
import { useResumeStore } from "./store/resume";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setChecked(true);
      return;
    }
    api
      .me()
      .then(() => {
        setOk(true);
        setChecked(true);
      })
      .catch(() => {
        setChecked(true);
      });
  }, []);

  if (!checked) return <div className="min-h-screen flex items-center justify-center text-slate-400">加载中…</div>;
  return ok ? <>{children}</> : <Navigate to="/login" replace />;
}

// /editor 无 id 时：拉列表，跳到最近一份；都没有则进入空白新建态
function EditorIndex() {
  const navigate = useNavigate();
  const { id, loadList, reset } = useResumeStore();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      // 优先用本地记录的最近 id（若仍存在）
      if (id) {
        const list = await loadList();
        if (list.some((r) => r.id === id)) {
          navigate(`/editor/${id}`, { replace: true });
          return;
        }
      }
      // 无最近 id 或已被删除：取列表第一份
      const list = await loadList();
      if (list.length > 0) {
        navigate(`/editor/${list[0].id}`, { replace: true });
      } else {
        // 一份都没有：进入空白编辑态（用户填完点保存时走 createResume）
        reset();
        setChecking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (checking) return <div className="min-h-screen flex items-center justify-center text-slate-400">加载中…</div>;
  return <Editor />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/editor"
        element={
          <RequireAuth>
            <EditorIndex />
          </RequireAuth>
        }
      />
      <Route
        path="/editor/:id"
        element={
          <RequireAuth>
            <Editor />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/editor" replace />} />
    </Routes>
  );
}
