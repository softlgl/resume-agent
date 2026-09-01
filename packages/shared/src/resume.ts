// 简历数据结构定义（前后端共用）

export interface BasicInfo {
  name: string;
  title: string; // 求职意向 / 头衔
  phone: string;
  email: string;
  location: string;
  website: string;
  summary: string; // 个人简介
  avatar: string; // 头像 URL（可选）
  birthday: string; // 出生年月，格式 YYYY-MM
  gender: string; // 性别
  currentStatus: string; // 当前状态：在职 / 离职 / 应届 等
  expectedSalary: string; // 期望薪资
  workYears: string; // 工作年限
}

// 根据出生年月（YYYY-MM）计算年龄；无法解析时返回空串
export function calcAge(birthday: string): string {
  if (!birthday) return "";
  const m = /^(\d{4})-(\d{1,2})/.exec(birthday.trim());
  if (!m) return "";
  const by = Number(m[1]);
  const bm = Number(m[2]);
  const now = new Date();
  let age = now.getFullYear() - by;
  if (now.getMonth() + 1 < bm) age -= 1;
  return age > 0 && age < 120 ? String(age) : "";
}

export interface WorkExp {
  id: string;
  company: string;
  role: string;
  start: string;
  end: string;
  current: boolean; // 至今
  description: string; // 支持换行
}

export interface EduExp {
  id: string;
  school: string;
  major: string;
  degree: string;
  start: string;
  end: string;
  description: string;
}

export interface ProjectExp {
  id: string;
  name: string;
  role: string;
  start: string;
  end: string;
  link: string;
  description: string;
}

export interface SkillGroup {
  id: string;
  category: string; // 分类，如 前端 / 后端 / 语言
  items: string; // 逗号或换行分隔的技能
}

export interface ResumeContent {
  basic: BasicInfo;
  works: WorkExp[];
  educations: EduExp[];
  projects: ProjectExp[];
  skills: SkillGroup[];
}

// 后端存储结构：简历记录
export interface ResumeRecord {
  id: string;
  userId: string;
  title: string;
  templateId: string;
  content: ResumeContent;
  createdAt: string;
  updatedAt: string;
}

// 创建/更新简历时的请求体（content 为简历数据）
export interface SaveResumeInput {
  title: string;
  templateId: string;
  content: ResumeContent;
}

export function emptyResumeContent(): ResumeContent {
  return {
    basic: {
      name: "",
      title: "",
      phone: "",
      email: "",
      location: "",
      website: "",
      summary: "",
      avatar: "",
      birthday: "",
      gender: "",
      currentStatus: "",
      expectedSalary: "",
      workYears: "",
    },
    works: [],
    educations: [],
    projects: [],
    skills: [],
  };
}
