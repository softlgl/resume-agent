# Resume Agent（简历助手）

全栈在线简历工具：注册登录后填写简历内容，实时预览多种模板，一键导出 **Word（.docx）** 与 **PDF**。
前后端共用一套排版令牌与模板配置，保证「网页预览 / PDF / DOCX」三端视觉一致。

![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-4-000000?logo=fastify&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-5-2D3748?logo=prisma&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/Tailwind-3.4-38B2AC?logo=tailwindcss&logoColor=white)

## 功能特性

- **账号体系**：用户名 + 密码注册登录，bcrypt 加密存储，JWT（有效期 7 天）鉴权，数据按用户隔离。
- **多份简历**：支持新建、切换、重命名、删除，自动跳转到最近编辑的一份。
- **结构化编辑**：基本信息、个人简介、工作经历、教育经历、项目经历、技能分组，条目可增删与排序。
- **6 套模板**：经典单栏 / 现代双栏 / 极简留白 / 科技蓝 / 优雅紫 / 清新绿，支持单栏与双栏布局。
- **实时预览**：编辑区与预览区左右分栏，预览基于与导出端完全相同的排版令牌渲染。
- **一键导出**：导出 `.docx`；导出 `.pdf` 时优先走 DOCX → Word 转换，无 Word 环境自动降级为 PDFKit 渲染。
- **中文排版**：内置思源黑体、宋体等字体方案，导出不乱码。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 18 · React Router 6 · Zustand · React Hook Form · Tailwind CSS · Vite 5 |
| 后端 | Fastify 4 · Prisma 5 · Zod · bcryptjs · jsonwebtoken |
| 导出 | `docx`（DOCX 渲染）· PDFKit（PDF 降级渲染）· Word COM（DOCX → PDF） |
| 数据 | MySQL 8 |
| 工程 | npm workspaces 单体仓库 · TypeScript（`shared` 包被前后端共同引用） |

## 目录结构

```
resume-agent/
├─ packages/
│  ├─ shared/                 # 前后端共用：简历数据结构、模板配置、排版令牌
│  │  └─ src/
│  │     ├─ resume.ts         # ResumeContent 等类型 + emptyResumeContent()
│  │     ├─ templates.ts      # 6 套模板配置 + PRINT 排版令牌 + 文本工具
│  │     └─ index.ts
│  ├─ server/                 # Fastify 后端
│  │  ├─ src/
│  │  │  ├─ index.ts          # 应用入口（CORS / 插件 / 路由注册）
│  │  │  ├─ plugins/          # prisma.ts（数据库）、auth.ts（JWT 校验钩子）
│  │  │  ├─ modules/          # auth.ts、resume.ts、export.ts 路由
│  │  │  └─ export/           # docx.ts、pdf.ts 渲染实现
│  │  ├─ assets/fonts/        # 中文字体（思源黑体、宋体）
│  │  └─ prisma/              # schema.prisma、seed.ts
│  └─ client/                 # React 前端
│     └─ src/
│        ├─ pages/            # Login.tsx、Editor.tsx
│        ├─ components/       # Preview、SectionForm、TemplatePicker、ResumeSwitcher …
│        ├─ api/client.ts     # 统一请求封装（自动携带 Bearer Token）
│        └─ store/resume.ts   # Zustand 状态
├─ start.bat / stop.bat       # Windows 一键启动 / 停止
└─ package.json               # npm workspaces 根配置
```

## 快速开始

### 环境要求

- Node.js **≥ 20**（后端启动脚本使用 `--env-file`）
- npm **≥ 9**（需要 workspaces 支持）
- MySQL **≥ 8**
- Windows 导出 PDF 的最佳效果依赖本机安装 **Microsoft Word**（缺失时自动降级）

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

在项目**根目录**创建 `.env`（后端通过 `--env-file=../../.env` 读取）：

```env
# MySQL 连接串
DATABASE_URL="mysql://root:password@localhost:3306/resume_agent"

# JWT 签名密钥，生产环境务必替换为长随机字符串
JWT_SECRET="change_me_to_a_long_random_secret_string"

# 后端端口，默认 4000
PORT=4000

# 允许跨域的前端地址，多个用英文逗号分隔
CLIENT_ORIGIN="http://localhost:5173"
```

> `.env` 已被 `.gitignore` 忽略，请勿提交。

### 3. 初始化数据库

```bash
# 首次创建表结构（推荐）
npm run db:push

# 或生成并使用迁移文件
npm run db:generate
npm run db:migrate

# 可选：写入示例数据
npm run db:seed --workspace=@resume-agent/server
```

### 4. 启动服务

```bash
# 终端 1：后端 http://localhost:4000
npm run dev:server

# 终端 2：前端 http://localhost:5173
npm run dev:client
```

Windows 用户可直接双击 **`start.bat`** 一键启动（自动装依赖、清理端口占用、打开浏览器），用 **`stop.bat`** 停止。

打开 <http://localhost:5173> 注册账号即可开始使用。

### 5. 生产构建

```bash
npm run build                                 # 构建全部子包
npm run start --workspace=@resume-agent/server  # 运行编译后的后端
```

前端构建产物位于 `packages/client/dist`，可交给任意静态服务器托管（需将 `/auth`、`/resumes`、`/export`、`/health` 反向代理到后端）。

## 可用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev:server` | 以 `tsx watch` 热重载启动后端 |
| `npm run dev:client` | 启动 Vite 开发服务器 |
| `npm run build` | 构建所有子包（含 TypeScript 编译） |
| `npm run db:push` | 将 Prisma schema 同步到数据库 |
| `npm run db:generate` | 生成 Prisma Client 与迁移 |
| `npm run db:migrate` | 应用数据库迁移 |
| `npm run db:seed --workspace=@resume-agent/server` | 写入种子数据 |

## API 接口

后端默认地址 `http://localhost:4000`，除 `/health`、`/auth/register`、`/auth/login` 外均需在请求头携带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，返回 `{ "ok": true }` |
| POST | `/auth/register` | 注册（用户名 3–32 位，密码 6–64 位），返回 token |
| POST | `/auth/login` | 登录，返回 token |
| GET | `/auth/me` | 获取当前登录用户名 |
| GET | `/resumes` | 当前用户的简历列表（按更新时间倒序） |
| GET | `/resumes/:id` | 简历详情 |
| POST | `/resumes` | 新建简历，body：`{ title, templateId, content }` |
| PUT | `/resumes/:id` | 更新简历，body 同上 |
| DELETE | `/resumes/:id` | 删除简历 |
| GET | `/export/:id/:format` | 导出文件，`format` 为 `docx` 或 `pdf` |

## 模板一览

| ID | 名称 | 布局 | 适用场景 |
| --- | --- | --- | --- |
| `classic` | 经典单栏 | 单栏 | 传统行业与大多数岗位 |
| `modern` | 现代双栏 | 双栏 | 希望突出基本信息的候选人 |
| `minimal` | 极简留白 | 单栏 | 设计、创意类岗位 |
| `tech` | 科技蓝 | 双栏 | 工程师，强调技能与技术栈 |
| `elegant` | 优雅紫 | 单栏 | 产品、运营、市场岗位 |
| `green` | 清新绿 | 双栏 | 教育、医疗、公益等行业 |

模板为配置驱动，新增模板只需在 `packages/shared/src/templates.ts` 中追加一项 `TemplateConfig`（配色、字体、区块顺序），三端会自动生效。

## 导出说明

- **DOCX**：由 `docx` 库直接生成，宋体统一中英文字体。
- **PDF**：优先生成 DOCX 后调用本机 **Microsoft Word（COM）** 另存为 PDF，版式与 Word 完全一致；
  非 Windows 或未安装 Word 时，自动降级为 **PDFKit** 坐标布局渲染，字体读取 `C:\Windows\Fonts\STSONG.TTF`。
- 下载文件名支持中文（同时输出 `filename` 与 `filename*=UTF-8''` 两种形式）。

## 常见问题

**启动后端报 `PrismaClient` 相关错误**
先执行 `npm run db:generate` 生成 Client，再确认 `.env` 中的 `DATABASE_URL` 可连通。

**端口被占用**
`start.bat` 会自动清理 4000 / 5173 端口；手动启动时可先运行 `stop.bat`，或修改 `.env` 的 `PORT`。

**导出 PDF 版式与预览有细微差异**
说明走了 PDFKit 降级路径，在装有 Microsoft Word 的 Windows 上运行即可获得与预览一致的效果。

**导出的 PDF 中文乱码**
降级路径依赖系统字体 `STSONG.TTF`（华文宋体），请确认该字体存在，或更换 `packages/server/src/export/pdf.ts` 中的 `FONT_PATH`。

## 许可证

本项目当前未指定开源许可证，如需开源请自行添加 `LICENSE` 文件。
