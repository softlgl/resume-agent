import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import type { ResumeContent } from "../../../packages/shared/src/resume.js";

// 默认初始化账号，可通过环境变量覆盖。
// 运行方式会带上 --env-file（见 package.json 的 db:seed），因此 DATABASE_URL 已就绪。
const DEFAULT_USERNAME = process.env.SEED_USERNAME ?? "admin";
const DEFAULT_PASSWORD = process.env.SEED_PASSWORD ?? "admin123";

// 一份内容丰富的「前端工程师」模拟简历，内容量足以触发分页（约 2 页）
const demoContent: ResumeContent = {
  basic: {
    name: "陈思远",
    title: "资深前端工程师 / 技术专家",
    phone: "138-0013-8888",
    email: "chen.siyuan@example.com",
    location: "上海市浦东新区",
    website: "https://siyuan.dev",
    summary:
      "8 年前端开发经验，专注于大型 Web 应用架构与性能优化。\n主导过百万级 DAU 产品的技术升级，推动微前端落地，将首屏加载时间从 4.2s 优化至 1.1s。\n擅长 React/TypeScript 生态，有丰富的跨端协同与工程化经验，注重团队协作与代码质量。",
    avatar: "",
    birthday: "1992-08",
    gender: "男",
    currentStatus: "在职",
    expectedSalary: "35-50K · 14薪",
    workYears: "8年",
  },
  works: [
    {
      id: "w1",
      company: "字节跳动 · 抖音电商",
      role: "资深前端工程师 · 技术负责人",
      start: "2021-03",
      end: "",
      current: true,
      description:
        "负责抖音电商商家后台前端架构与核心功能研发，团队规模 12 人。\n" +
        "- 主导商家工作台微前端改造，将巨型应用拆分为 6 个子应用，独立部署、独立迭代，构建效率提升 40%\n" +
        "- 推动全量 TypeScript 改造，建立类型安全边界与 API 契约层，线上缺陷率下降 35%\n" +
        "- 设计基于 Webpack 5 Module Federation 的运行时加载方案，首屏资源体积下降 52%\n" +
        "- 搭建可视化性能监控大盘，覆盖 LCP/FID/CLS 等核心指标，建立性能红线告警机制\n" +
        "- 带领团队完成 4 次大促活动保障，0 故障，获得部门技术突破奖",
    },
    {
      id: "w2",
      company: "蚂蚁集团 · 支付宝",
      role: "高级前端工程师",
      start: "2018-07",
      end: "2021-02",
      current: false,
      description:
        "参与支付宝小程序框架与商家平台研发。\n" +
        "- 负责小程序 IDE 可视化搭建模块，日活开发者 2000+，组件拖拽体验对标专业低代码平台\n" +
        "- 主导商家营销活动配置平台前端，支持 50+ 运营人员自助配置活动，配置到上线周期从 3 天缩短至 2 小时\n" +
        "- 推动团队 CI/CD 升级，引入自动化测试与 Lint 门禁，代码评审周期下降 60%\n" +
        "- 参与开源项目 ant-design-contributions，提交 15+ 合并请求",
    },
    {
      id: "w3",
      company: "美团 · 到店事业群",
      role: "前端工程师",
      start: "2016-04",
      end: "2018-06",
      current: false,
      description:
        "负责到店商家端 H5 与后台系统研发。\n" +
        "- 主导商家中心 React 技术栈迁移，从 jQuery + 模板引擎平滑过渡到 React 16\n" +
        "- 设计基于 qiankun 的多业务线集成方案，支撑 5 个业务方共用同一套登录与权限体系\n" +
        "- 优化商家端 H5 首屏加载，通过资源预加载 + 路由懒加载，首屏时间下降 45%",
    },
    {
      id: "w4",
      company: "某创业公司",
      role: "前端开发实习生",
      start: "2015-09",
      end: "2016-03",
      current: false,
      description:
        "参与公司 SaaS 产品前端开发，独立完成报表模块与用户管理模块。\n使用 Vue 1.0 + jQuery 混合架构，积累了组件化与状态管理的早期实践经验。",
    },
  ],
  educations: [
    {
      id: "e1",
      school: "浙江大学",
      major: "计算机科学与技术",
      degree: "硕士",
      start: "2013-09",
      end: "2015-06",
      description: "GPA 3.8/4.0，研究方向：前端性能优化与可视化。\n曾获研究生国家奖学金，发表 SCI 论文 1 篇。",
    },
    {
      id: "e2",
      school: "武汉大学",
      major: "软件工程",
      degree: "本科",
      start: "2009-09",
      end: "2013-06",
      description: "GPA 3.7/4.0，院系学生会技术部负责人。\n获 ACM 校赛银奖，全国大学生软件创新大赛二等奖。",
    },
  ],
  projects: [
    {
      id: "p1",
      name: "商家工作台微前端架构",
      role: "架构负责人",
      start: "2022-01",
      end: "2022-09",
      link: "",
      description:
        "基于 Module Federation 的运行时微前端方案，支撑 6 个业务子应用的独立开发与部署。\n" +
        "- 设计共享依赖策略，React/runtime 复用率 92%，包体积下降 52%\n" +
        "- 实现子应用沙箱与样式隔离，避免全局污染\n" +
        "- 输出架构文档与迁移指南，推动 3 个业务线顺利完成迁移",
    },
    {
      id: "p2",
      name: "性能监控可视化平台",
      role: "前端负责人",
      start: "2022-10",
      end: "2023-03",
      link: "https://perf.siyuan.dev",
      description:
        "基于 Web Vitals 与自定义指标的性能采集与可视化平台。\n" +
        "- 采集 LCP/FID/CLS/TTI 等核心指标，覆盖 P95/P99 分位\n" +
        "- 使用 ECharts 构建多维度分析看板，支持按页面/版本/地域下钻\n" +
        "- 接入告警机器人，性能劣化 10 分钟内自动通知负责人",
    },
    {
      id: "p3",
      name: "小程序可视化搭建 IDE",
      role: "核心开发",
      start: "2019-05",
      end: "2020-08",
      link: "",
      description:
        "面向小程序开发者的可视化搭建工具，支持组件拖拽、属性配置、代码生成。\n" +
        "- 基于自研 DSL 描述页面结构，生成可维护的 React 代码\n" +
        "- 内置 80+ 物料组件，支持自定义扩展\n" +
        "- 日活开发者 2000+，组件复用率提升 3 倍",
    },
  ],
  skills: [
    {
      id: "s1",
      category: "前端核心",
      items: "JavaScript, TypeScript, ES6+, HTML5, CSS3, Sass, Tailwind CSS",
    },
    { id: "s2", category: "框架与生态", items: "React, Vue 2/3, Next.js, Redux, Zustand, React Query" },
    {
      id: "s3",
      category: "工程化",
      items: "Webpack, Vite, Rollup, Babel, ESLint, Prettier, Husky, pnpm Workspaces",
    },
    {
      id: "s4",
      category: "微前端",
      items: "Module Federation, qiankun, single-spa, Web Components",
    },
    {
      id: "s5",
      category: "可视化",
      items: "ECharts, D3.js, Three.js, Canvas, SVG",
    },
    {
      id: "s6",
      category: "服务端",
      items: "Node.js, Express, Fastify, NestJS, Prisma, PostgreSQL",
    },
    {
      id: "s7",
      category: "测试与质量",
      items: "Jest, Vitest, Testing Library, Playwright, Cypress",
    },
    { id: "s8", category: "协作工具", items: "Git, Docker, CI/CD, GitHub Actions, Jenkins" },
  ],
};

async function main() {
  const prisma = new PrismaClient();

  try {
    let user = await prisma.user.findUnique({
      where: { username: DEFAULT_USERNAME },
    });

    if (!user) {
      const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
      user = await prisma.user.create({
        data: { username: DEFAULT_USERNAME, password: hash },
      });
      console.log(`[seed] 已创建初始账号：`);
      console.log(`        用户名：${user.username}`);
      console.log(`        密码：${DEFAULT_PASSWORD}`);
    } else {
      console.log(`[seed] 账号 "${DEFAULT_USERNAME}" 已存在。`);
    }

    // 为 admin 追加一份分页测试简历（若已存在同名则跳过）
    const demoTitle = "分页测试简历 · 资深前端工程师";
    const existDemo = await prisma.resume.findFirst({
      where: { userId: user.id, title: demoTitle },
    });
    if (existDemo) {
      console.log(`[seed] 分页测试简历已存在，跳过。`);
      return;
    }

    await prisma.resume.create({
      data: {
        userId: user.id,
        title: demoTitle,
        templateId: "classic",
        content: demoContent as any,
      },
    });
    console.log(`[seed] 已为 "${DEFAULT_USERNAME}" 追加分页测试简历。`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[seed] 初始化账号失败：", err);
  process.exit(1);
});
