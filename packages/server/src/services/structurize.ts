// LLM 结构化：把抽取到的纯文本归一化成 ResumeContent（schema 定死键名 + 语义归一化）
import type { ResumeContent } from "@resume-agent/shared";
import { chatStream, parseJSON, isLLMAvailable } from "./llm.js";

// 期望 LLM 输出 ResumeContent 结构（键名固定，语义归一化由 LLM 完成）
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    basic: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        location: { type: "string" },
        website: { type: "string" },
        summary: { type: "string" },
        birthday: { type: "string" },
        gender: { type: "string" },
        currentStatus: { type: "string" },
        expectedSalary: { type: "string" },
        workYears: { type: "string" },
      },
      required: ["name", "title", "phone", "email", "location", "website", "summary", "birthday", "gender", "currentStatus", "expectedSalary", "workYears"],
      additionalProperties: false,
    },
    works: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          role: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          current: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["company", "role", "start", "end", "current", "description"],
        additionalProperties: false,
      },
    },
    educations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          school: { type: "string" },
          major: { type: "string" },
          degree: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          description: { type: "string" },
        },
        required: ["school", "major", "degree", "start", "end", "description"],
        additionalProperties: false,
      },
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          company: { type: "string" },
          role: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          link: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "company", "role", "start", "end", "link", "description"],
        additionalProperties: false,
      },
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string" },
          items: { type: "string" },
        },
        required: ["category", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["basic", "works", "educations", "projects", "skills"],
  additionalProperties: false,
} as const;

function buildPrompt(text: string) {
  const system = `你是一名简历数据提取助手。请从用户提供的简历原文中提取信息，**只用下面给定的键名**输出一个 JSON 对象，用于归一化到统一的简历数据结构。

输出必须严格符合以下结构（字段缺失时填空字符串；数组缺省为空数组）：
- basic: { name(姓名), title(求职意向/头衔), phone(手机号), email(邮箱), location(所在城市), website(个人主页,没有填空), summary(个人简介/自我评价), birthday(出生年月,格式YYYY-MM), gender(性别), currentStatus(当前状态:在职/离职等), expectedSalary(期望薪资), workYears(工作年限) }
- works: 工作经历数组，每项 { company(公司/任职单位), role(职位/岗位), start(开始时间,如2020-07), end(结束时间,如2024-12,标注"至今/现在"时为空), current(布尔:是否至今), description(工作内容/成果,可含换行) }
- educations: 教育经历数组，每项 { school(学校), major(专业), degree(学历/学位), start, end, description }
- projects: 项目经历数组，每项 { name(项目名), company(所属公司:从工作经历的公司中推断;个人/开源或无公司时可填空), role(你的角色), start, end, link(项目链接,没有填空), description }
- skills: 技能分组数组，每项 { category(技能分类,如"前端"), items(该分类下技能,用英文逗号或顿号连接成字符串) }

规则：
1. 只输出 JSON，不要任何解释、markdown 代码块或额外文字。
2. 把原文里不同的说法归一化到上面固定键：例如"公司名称/任职单位/单位"→company；"职位/岗位/担任职务"→role；"起止时间"→start/end；"教育背景/学历/学校"→school；"专业技能→skills"。时间统一转成 YYYY-MM。
3. 无法识别或原文缺失的字段填空字符串，不要编造。
4. current 为 true 当且仅当原文标注了"至今/现在/在职中"。`;
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `以下是简历原文，请提取：\n\n${text}` },
  ];
}

/** 把纯文本归一化成 ResumeContent；无 LLM 或解析失败返回 null */
export async function structurizeText(text: string, onReasoning?: (delta: string) => void, onContent?: (delta: string) => void): Promise<ResumeContent | null> {
  if (!isLLMAvailable()) return null;
  // maxTokens 给个足够大的上限，让真实卡点收敛到 profile.maxOutput（用户按模型配置），
  // 避免这里写死的小值盖掉配置。推理模型(reasoning_content)与正文共享预算，偏小易截断。
  const out = await chatStream(buildPrompt(text), { jsonSchema: EXTRACT_SCHEMA, temperature: 0.1, maxTokens: 262144 }, onReasoning, onContent);
  if (out == null) return null;
  const raw = parseJSON<any>(out);
  if (!raw || typeof raw !== "object") return null;
  return normalize(raw);
}

function normalize(raw: any): ResumeContent {
  const basic = raw.basic || {};
  const str = (v: any, d = ""): string => (v == null ? d : String(v));
  const arr = (v: any): any[] => (Array.isArray(v) ? v : []);
  const nid = (): string => `id_${Math.random().toString(36).slice(2, 10)}`;

  return {
    basic: {
      name: str(basic.name),
      title: str(basic.title),
      phone: str(basic.phone),
      email: str(basic.email),
      location: str(basic.location),
      website: str(basic.website),
      summary: str(basic.summary),
      avatar: "",
      birthday: str(basic.birthday),
      gender: str(basic.gender),
      currentStatus: str(basic.currentStatus),
      expectedSalary: str(basic.expectedSalary),
      workYears: str(basic.workYears),
    },
    works: arr(raw.works).map((w: any) => ({
      id: nid(),
      company: str(w.company),
      role: str(w.role),
      start: str(w.start),
      end: str(w.end),
      current: !!w.current,
      description: str(w.description),
    })),
    educations: arr(raw.educations).map((e: any) => ({
      id: nid(),
      school: str(e.school),
      major: str(e.major),
      degree: str(e.degree),
      start: str(e.start),
      end: str(e.end),
      description: str(e.description),
    })),
    projects: arr(raw.projects).map((p: any) => ({
      id: nid(),
      name: str(p.name),
      company: str(p.company),
      role: str(p.role),
      start: str(p.start),
      end: str(p.end),
      link: str(p.link),
      description: str(p.description),
    })),
    skills: arr(raw.skills).map((s: any) => ({
      id: nid(),
      category: str(s.category),
      items: Array.isArray(s.items) ? s.items.map((x: any) => str(x)).join(", ") : str(s.items),
    })),
  };
}