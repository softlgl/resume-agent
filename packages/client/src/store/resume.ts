import { create } from "zustand";
import {
  emptyResumeContent,
  type ResumeContent,
  type SaveResumeInput,
} from "@resume-agent/shared";
import { api } from "../api/client";

// 最近编辑的简历 id（用于 /editor 无参数时跳转）
const CURRENT_KEY = "resume_agent_current_id";

function getCurrentId(): string | null {
  return localStorage.getItem(CURRENT_KEY);
}
function setCurrentId(id: string | null) {
  if (id) localStorage.setItem(CURRENT_KEY, id);
  else localStorage.removeItem(CURRENT_KEY);
}

// 每份简历独立 draft（防止刷新丢失未保存内容）
function draftKey(id: string) {
  return `resume_agent_draft_${id}`;
}
function loadDraft(id: string): Partial<ResumeState> | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function persistDraft(id: string, snapshot: Partial<ResumeState>) {
  try {
    localStorage.setItem(
      draftKey(id),
      JSON.stringify({
        title: snapshot.title,
        templateId: snapshot.templateId,
        content: snapshot.content,
      })
    );
  } catch {
    /* ignore quota */
  }
}
function clearDraft(id: string) {
  localStorage.removeItem(draftKey(id));
}

export interface ResumeMeta {
  id: string;
  title: string;
  templateId: string;
  updatedAt: string;
}

interface ResumeState {
  id: string | null;
  title: string;
  templateId: string;
  content: ResumeContent;
  lastSavedAt: number | null;
  loading: boolean;
  error: string | null;

  // 多简历列表
  list: ResumeMeta[];
  listLoading: boolean;

  setField: <K extends keyof ResumeContent>(key: K, value: ResumeContent[K]) => void;
  setTitle: (t: string) => void;
  setTemplate: (id: string) => void;
  load: (data: { id: string; title: string; templateId: string; content: ResumeContent }) => void;
  reset: () => void;
  toInput: () => SaveResumeInput;
  markSaved: () => void;

  // 多简历操作
  loadList: () => Promise<ResumeMeta[]>;
  loadResume: (id: string) => Promise<boolean>;
  createNew: (templateId: string, fromCurrent: boolean) => Promise<string | null>;
  remove: (id: string) => Promise<boolean>;
}

export const useResumeStore = create<ResumeState>((set, get) => ({
  id: getCurrentId(),
  title: "我的简历",
  templateId: "classic",
  content: emptyResumeContent(),
  lastSavedAt: null,
  loading: false,
  error: null,
  list: [],
  listLoading: false,

  setField: (key, value) => {
    set((s) => {
      const next = { ...s, content: { ...s.content, [key]: value } };
      if (s.id) persistDraft(s.id, next);
      return next;
    });
  },
  setTitle: (t) => {
    set((s) => {
      const next = { ...s, title: t };
      if (s.id) {
        persistDraft(s.id, next);
        // 同步更新列表缓存（不立刻发请求，保存时再持久化）
        return { ...next, list: s.list.map((r) => (r.id === s.id ? { ...r, title: t } : r)) };
      }
      return next;
    });
  },
  setTemplate: (id) => {
    set((s) => {
      const next = { ...s, templateId: id };
      if (s.id) {
        persistDraft(s.id, next);
        return { ...next, list: s.list.map((r) => (r.id === s.id ? { ...r, templateId: id } : r)) };
      }
      return next;
    });
  },
  load: (data) => {
    set({
      id: data.id,
      title: data.title,
      templateId: data.templateId,
      content: data.content,
      error: null,
    });
    setCurrentId(data.id);
    persistDraft(data.id, get());
  },
  reset: () => {
    const prevId = get().id;
    if (prevId) clearDraft(prevId);
    set({ id: null, title: "我的简历", templateId: "classic", content: emptyResumeContent() });
    setCurrentId(null);
  },
  toInput: () => {
    const { title, templateId, content } = get();
    return { title, templateId, content };
  },
  markSaved: () => set({ lastSavedAt: Date.now() }),

  // 拉取简历列表
  loadList: async () => {
    set({ listLoading: true });
    try {
      const res = await api.listResumes();
      const list = (res.resumes || []) as ResumeMeta[];
      set({ list, listLoading: false });
      return list;
    } catch (err: any) {
      set({ listLoading: false, error: err.message });
      return [];
    }
  },

  // 加载指定简历（优先用 draft，回退到后端）
  loadResume: async (id) => {
    set({ loading: true, error: null });
    try {
      const res = await api.getResume(id);
      const r = res.resume;
      const draft = loadDraft(id);
      // draft 优先（未保存的草稿覆盖服务端版本）
      // 但若 draft.content 是空状态（无姓名且无任何经历），说明是误写的空 draft，丢弃以免覆盖完整数据
      const draftContent = draft?.content;
      const draftIsEmpty =
        !!draftContent &&
        !draftContent.basic?.name &&
        !(draftContent.works?.length || draftContent.educations?.length || draftContent.projects?.length || draftContent.skills?.length);
      if (draftIsEmpty) clearDraft(id);
      const useContent = (draftIsEmpty ? r.content : draftContent ?? r.content) as ResumeContent;
      const data = {
        id: r.id,
        title: draft?.title ?? r.title,
        templateId: draft?.templateId ?? r.templateId,
        content: useContent,
      };
      set({ ...data, loading: false });
      setCurrentId(id);
      // 同步列表项标题/模板（防止 draft 与列表不一致）
      set((s) => ({
        list: s.list.map((it) =>
          it.id === id ? { ...it, title: data.title, templateId: data.templateId } : it
        ),
      }));
      return true;
    } catch (err: any) {
      set({ loading: false, error: err.message });
      return false;
    }
  },

  // 新建简历：选模板 + 空白/复制当前
  createNew: async (templateId, fromCurrent) => {
    const baseContent = fromCurrent ? get().content : emptyResumeContent();
    try {
      const res = await api.createResume({
        title: fromCurrent ? `${get().title} 副本` : "我的简历",
        templateId,
        content: baseContent,
      });
      const newId = res.resume.id;
      // 刷新列表
      await get().loadList();
      return newId;
    } catch (err: any) {
      set({ error: err.message });
      return null;
    }
  },

  // 删除简历（并清理 draft）
  remove: async (id) => {
    try {
      await api.deleteResume(id);
      clearDraft(id);
      // 刷新列表
      const list = await get().loadList();
      // 如果删除的是当前简历，切到第一份（或清空）
      if (get().id === id) {
        if (list.length > 0) {
          await get().loadResume(list[0].id);
        } else {
          get().reset();
        }
      }
      return true;
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },
}));
