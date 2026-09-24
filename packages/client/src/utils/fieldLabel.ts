// 把字段路径（works[0].description / basic.summary）转成中文可读定位文本
// 口径与后端 services/resume-edit.ts 的 buildFieldLabel 保持一致

const SECTION_LABELS: Record<string, string> = {
  basic: "基本信息",
  works: "工作经历",
  educations: "教育经历",
  projects: "项目经历",
  skills: "技能",
};

const FIELD_LABELS: Record<string, string> = {
  name: "姓名",
  title: "求职意向",
  phone: "手机号",
  email: "邮箱",
  location: "所在地",
  website: "个人主页",
  summary: "个人简介",
  avatar: "头像",
  birthday: "出生年月",
  gender: "性别",
  currentStatus: "当前状态",
  expectedSalary: "期望薪资",
  workYears: "工作年限",
  company: "公司名称",
  role: "职位",
  start: "开始时间",
  end: "结束时间",
  current: "是否至今",
  description: "描述",
  school: "学校",
  major: "专业",
  degree: "学历",
  link: "项目链接",
  category: "分类",
  items: "技能",
};

// 同名字段在不同 section 下中文名不同
const SECTION_FIELD_OVERRIDES: Record<string, Record<string, string>> = {
  projects: { name: "项目名称" },
};

export function fieldToLabel(field: string): string {
  if (!field) return "";
  const tokens = field.split(/[.\[\]]+/).filter(Boolean);
  if (tokens.length === 0) return field;
  const section = tokens[0];
  const sectionLabel = SECTION_LABELS[section] || section;
  const m = field.match(/\[(\d+)\]/);
  const idxPart = m ? ` · 第${Number(m[1]) + 1}条` : "";
  const lastKey = tokens[tokens.length - 1];
  if (!m && tokens.length === 1) return sectionLabel;
  const fieldName =
    SECTION_FIELD_OVERRIDES[section]?.[lastKey] || FIELD_LABELS[lastKey] || lastKey;
  return `${sectionLabel}${idxPart} · ${fieldName}`;
}