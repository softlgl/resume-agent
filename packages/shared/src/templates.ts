// 模板配置（配置驱动，渲染函数读取这些配置生成 docx/pdf 与 HTML 预览）
import type { ResumeContent } from "./resume.js";

export type TemplateLayout = "single" | "two-column";

export interface TemplateConfig {
  id: string;
  name: string;
  description: string;
  layout: TemplateLayout;
  // 配色
  colors: {
    primary: string; // 主色（标题、强调）
    accent: string; // 辅助强调色
    sidebar?: string; // 双栏模板侧边栏背景
    text: string;
    muted: string;
    line: string;
  };
  font: {
    family: string;
    headingWeight: number;
  };
  // 是否在侧边栏显示基本信息（双栏模板用）
  sidebarBasic: boolean;
  // 区块顺序（控制渲染顺序）
  sectionOrder: ("summary" | "works" | "educations" | "projects" | "skills")[];
}

export const TEMPLATES: TemplateConfig[] = [
  {
    id: "classic",
    name: "经典单栏",
    description: "稳重专业的单栏布局，适合传统行业与大多数岗位。",
    layout: "single",
    colors: {
      primary: "#1E3A8A",
      accent: "#2563EB",
      text: "#0F172A",
      muted: "#475569",
      line: "#CBD5E1",
    },
    font: { family: "PingFang SC, Microsoft YaHei, sans-serif", headingWeight: 700 },
    sidebarBasic: false,
    sectionOrder: ["summary", "works", "educations", "projects", "skills"],
  },
  {
    id: "modern",
    name: "现代双栏",
    description: "左侧信息栏 + 右侧内容的现代双栏结构，突出基本信息。",
    layout: "two-column",
    colors: {
      primary: "#0F172A",
      accent: "#2563EB",
      sidebar: "#1E293B",
      text: "#0F172A",
      muted: "#475569",
      line: "#E2E8F0",
    },
    font: { family: "PingFang SC, Microsoft YaHei, sans-serif", headingWeight: 700 },
    sidebarBasic: true,
    sectionOrder: ["summary", "works", "educations", "projects", "skills"],
  },
  {
    id: "minimal",
    name: "极简留白",
    description: "大量留白与细线条，清爽极简，适合设计/创意岗位。",
    layout: "single",
    colors: {
      primary: "#111827",
      accent: "#6B7280",
      text: "#111827",
      muted: "#6B7280",
      line: "#E5E7EB",
    },
    font: { family: "PingFang SC, Microsoft YaHei, sans-serif", headingWeight: 600 },
    sidebarBasic: false,
    sectionOrder: ["summary", "works", "educations", "projects", "skills"],
  },
  {
    id: "tech",
    name: "科技蓝",
    description: "高饱和蓝色调，强调技能与技术栈，适合工程师岗位。",
    layout: "two-column",
    colors: {
      primary: "#0369A1",
      accent: "#0EA5E9",
      sidebar: "#0C4A6E",
      text: "#0F172A",
      muted: "#475569",
      line: "#BAE6FD",
    },
    font: { family: "PingFang SC, Microsoft YaHei, sans-serif", headingWeight: 700 },
    sidebarBasic: true,
    sectionOrder: ["skills", "works", "projects", "educations", "summary"],
  },
  {
    id: "elegant",
    name: "优雅紫",
    description: "柔和紫色调，优雅精致，适合产品/运营/市场岗位。",
    layout: "single",
    colors: {
      primary: "#6D28D9",
      accent: "#A855F7",
      text: "#1E1B4B",
      muted: "#6B7280",
      line: "#DDD6FE",
    },
    font: { family: "PingFang SC, Microsoft YaHei, sans-serif", headingWeight: 700 },
    sidebarBasic: false,
    sectionOrder: ["summary", "works", "projects", "educations", "skills"],
  },
  {
    id: "green",
    name: "清新绿",
    description: "自然清新绿色调，适合教育/医疗/公益等行业。",
    layout: "two-column",
    colors: {
      primary: "#15803D",
      accent: "#22C55E",
      sidebar: "#14532D",
      text: "#0F172A",
      muted: "#475569",
      line: "#BBF7D0",
    },
    font: { family: "PingFang SC, Microsoft YaHei, sans-serif", headingWeight: 700 },
    sidebarBasic: true,
    sectionOrder: ["summary", "educations", "works", "projects", "skills"],
  },
];

export function getTemplate(id: string): TemplateConfig {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

// 给渲染函数用的小工具：把技能字符串拆成数组
export function splitSkills(items: string): string[] {
  return items
    .split(/[,\n，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 把 #RRGGBB 主色按 alpha 混白，返回不透明的浅色 hex。
// 用途：章节软底带 / 姓名底带 / 技能胶囊背景。三端共用，确保预览/PDF/DOCX 颜色一致
// （DOCX 不支持透明度，必须用预混后的纯色）。
export function soften(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => Math.round(c * alpha + 255 * (1 - alpha));
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

export type { ResumeContent };

// ============================================================================
// 统一排版令牌（预览 / PDF / DOCX 共用，保证三者视觉一致）
// 单位约定：字号、边距一律用「磅 pt」。A4 = 210mm × 297mm = 595.28 × 841.89 pt。
// PDF 直接使用；DOCX 的 size 字段是 half-point，需 ×2；Preview 用 CSS pt 单位。
// ============================================================================
export const PRINT: {
  page: { width: number; height: number };
  margin: number;
  sidebarWidth: number;
  fontSize: Record<string, number>;
  spacing: {
    lineHeight: number;
    lineGap: number;
    bodyAfter: number;
    bulletAfter: number;
    blockAfter: number;
    sectionBefore: number;
    sectionAfter: number;
    nameAfter: number;
    titleAfter: number;
    contactAfter: number;
    extraAfter: number;
    sideNameAfter: number;
    sideTitleAfter: number;
    sideLabelBefore: number;
    sideLabelAfter: number;
    sideFieldAfter: number;
    sectionLineOffset: number;
    inlineTitleScale: number;
  };
  docxSize: (pt: number) => number;
} = {
  // 纸张（pt）
  page: { width: 595.28, height: 841.89 },
  // 单栏页边距（pt）
  margin: 40,
  // 双栏侧边栏宽度（pt，约占 32%）
  sidebarWidth: 190,
  // 字号（pt）
  fontSize: {
    name: 22, // 姓名（单栏标题）
    title: 13, // 职位副标题
    sectionTitle: 13, // 章节标题
    body: 10, // 正文
    bullet: 10, // 列表项正文
    small: 9.5, // 联系方式 / 附加信息
    sidebarName: 18, // 侧边栏姓名
    sidebarTitle: 11, // 侧边栏职位
    sidebarLabel: 12, // 侧边栏分节标题（如「联系方式」）
    sidebarField: 9, // 侧边栏字段
  },
  // 间距令牌（pt 基准）：预览 / PDF / DOCX 共用，确保三者行高、段后、章节间距视觉一致。
  // 预览按 px = pt * 4/3 换算；PDF 直接用 pt；DOCX 按 twips = pt * 20 换算。
  spacing: {
    lineHeight: 1.5, // 文本行高倍数（预览 lineHeight；PDF 行高 = size * lineHeight + lineGap；DOCX 行距倍数）
    lineGap: 2, // 文本行额外间距（pt）：PDF lineGap；DOCX 折算进 line 倍数；预览折叠进 lineHeight
    bodyAfter: 4, // 正文段后
    bulletAfter: 2, // 列表项段后
    blockAfter: 8, // 条目块（工作/教育/项目）整体下方间距
    sectionBefore: 10, // 章节标题前
    sectionAfter: 6, // 章节标题后
    nameAfter: 6, // 单栏姓名下方
    titleAfter: 8, // 单栏副标题下方
    contactAfter: 6, // 单栏联系方式下方
    extraAfter: 6, // 单栏附加信息下方
    sideNameAfter: 6, // 侧栏姓名下方
    sideTitleAfter: 10, // 侧栏副标题下方
    sideLabelBefore: 12, // 侧栏分节标题前
    sideLabelAfter: 4, // 侧栏分节标题后
    sideFieldAfter: 2, // 侧栏字段后
    sectionLineOffset: 1.3, // 章节标题下划线相对字号倍数偏移
    inlineTitleScale: 1.15, // 条目内标题字号相对 F.body 的倍数
  },
  // DOCX 字号转换：half-point（1pt = 2 half-point）
  docxSize: (pt: number) => Math.round(pt * 2),
};

/**
 * 去除单行文本开头的列表符号：
 *   Markdown 风格："- "、"* "、"+ "
 *   中文/全角/其他常见项目符号："• "、"· "、"– "、"— "、"1. " 等
 * 用于：工作/项目经历的描述行。因为渲染层会统一加 `- ` 前缀，
 * 若用户（或 seed 示例数据）在输入时已手写 `- `，不剥离会变成 `--`（两条横杠）。
 */
export function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*+•·–—]|\d+[.)])\s*/, "");
}

/** 按换行拆行 → trim → 去列表前缀 → 过滤空行。工作/项目描述专用。 */
export function splitBulletLines(text: string): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(stripBullet);
}
