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
- **多份简历**：顶栏下拉切换、重命名、删除（带二次确认）；新建简历走两步向导——先选模板，再选「空白」或「复制当前简历」（适合制作岗位变体副本）；进入编辑器自动恢复上次编辑的一份。
- **结构化编辑**：基本信息（姓名、求职意向、联系方式、出生年月、性别、当前状态、期望薪资、工作年限等）、个人简介、工作经历、教育经历、项目经历、技能分组，各区块条目可增删。
- **本地草稿**：编辑内容实时写入浏览器 localStorage（每份简历独立草稿），刷新页面不丢失；重新打开时草稿优先于服务端版本展示，保存后即固化。
- **6 套模板**：经典单栏 / 现代双栏 / 极简留白 / 科技蓝 / 优雅紫 / 清新绿，支持单栏与双栏布局。
- **实时预览**：编辑区与预览区左右分栏，预览基于与导出端完全相同的排版令牌渲染。
- **一键导出**：导出 `.docx`；导出 `.pdf` 时优先走 DOCX → Word 转换，无 Word 环境自动降级为 PDFKit 渲染。导出会复用预览算出的分页断点（`pageBreakIds`），保证输出与预览逐页一致。
- **中文排版**：DOCX 统一使用宋体（SimSun）；PDF 降级路径读取 Windows 系统字体 `STSONG.TTF`，中文不乱码。
- **AI 简历分析**：接入 OpenAI 兼容的 LLM（云端 DeepSeek/通义千问，或本地 Ollama·LM Studio·vLLM）。输出 ATS 友好度与内容质量评分、逐条问题清单（可定位跳转到对应区块并高亮）、能力雷达图与结构化总结；写作数据自动脱敏，分析结果落库、重开可回看，问题改写支持「应用到简历」，可选结合岗位 JD 做匹配分析。
- **多模型配置**：设置面板内可维护多套模型配置（Profile：供应商 / API Key / Base URL / 模型 / 上下文与输出上限），随时新增、修改、删除并切换激活；配置落库持久化，清空后自动回退到 `.env`。
- **导入 Word/PDF**：支持导入 `.docx` / `.pdf` 简历，自动提取文本并经 LLM 识别为可编辑的结构化字段，预览逐字段确认后另存为新简历；文字型 PDF 直接抽文本，扫描版（图片型 PDF）自动走本地 RapidOCR 识别。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 18 · React Router 6 · Zustand · React Hook Form · Tailwind CSS · Vite 5 |
| 后端 | Fastify 4 · Prisma 5 · Zod · bcryptjs · jsonwebtoken |
| 导出 | `docx`（DOCX 渲染）· PDFKit（PDF 降级渲染）· Word COM（DOCX → PDF） |
| AI | OpenAI 兼容协议 · 流式输出（SSE）· 结构化 JSON Schema |
| 导入/OCR | mammoth（docx 文本）· pdfjs-dist + @napi-rs/canvas（pdf 文本/渲染）· RapidOCR（扫描件 OCR，conda 环境） |
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
│  │  │  ├─ modules/          # auth.ts、resume.ts、export.ts、ai.ts、import.ts 路由
│  │  │  ├─ services/         # llm.ts、extract.ts、structurize.ts、ocripy.ts、redact.ts
│  │  │  ├─ types/            # 第三方库缺失类型声明（mammoth、pdfjs）
│  │  │  └─ export/           # docx.ts、pdf.ts 渲染实现
│  │  ├─ scripts/             # ocr.py（RapidOCR 子进程脚本）
│  │  └─ prisma/              # schema.prisma、seed.ts
│  └─ client/                 # React 前端
│     └─ src/
│        ├─ pages/            # Login.tsx、Editor.tsx
│        ├─ components/       # Preview、SectionForm、TemplatePicker、ResumeSwitcher、
│        │                    # NewResumeDialog、ImportResumeDialog、AIAnalysisPanel、ModelManager
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
- （可选）AI 简历分析需要一个 **OpenAI 兼容** 的 LLM 端点（默认 DeepSeek，也可用本地 Ollama / LM Studio / vLLM）；未配置时自动降级为本地硬规则检查
- （可选）导入**扫描版** PDF 需要本机安装 **conda + RapidOCR（onnxruntime）**，首次使用会自动创建 `resume_ocr` 虚拟环境并安装依赖

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

仓库已提供示例文件，复制一份到项目**根目录**后按实际环境修改（后端通过 `--env-file=../../.env` 读取）：

```bash
cp .env.example .env                    # Windows PowerShell: Copy-Item .env.example .env
```

必填项：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | MySQL 连接串，格式 `mysql://用户:密码@主机:端口/库名` |
| `JWT_SECRET` | JWT 签名密钥，生产环境务必替换为长随机字符串 |
| `PORT` | 后端端口，默认 `4000` |
| `CLIENT_ORIGIN` | 允许跨域的前端地址，多个用英文逗号分隔 |

可选（AI 简历分析，留空则不启用，自动降级为本地硬规则检查）：

| 变量 | 说明 |
| --- | --- |
| `LLM_PROVIDER` | `deepseek` / `openai` / `doubao` / `qwen` / `ollama` / `lmstudio` / `vllm`，默认 `deepseek` |
| `LLM_API_KEY` | 云端供应商必填；本地模型（ollama / lmstudio / vllm）留空 |
| `LLM_BASE_URL` | 留空则使用该供应商默认地址（如 Ollama `http://localhost:11434/v1`） |
| `LLM_MODEL` | 留空则使用该供应商推荐模型 |

此外，导入扫描版 PDF 时可设置 `RESUME_OCR_ENV`（OCR 用 conda 环境名，默认 `resume_ocr`）与 `CONDA_EXE`（conda 可执行文件路径，默认从 PATH 查找）。

> 也可跳过 `.env`，直接在应用内的「模型设置」面板中维护模型配置（落库保存、可随时切换激活）。

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

前端构建产物位于 `packages/client/dist`，可交给任意静态服务器托管（需将 `/auth`、`/resumes`、`/export`、`/ai`、`/import`、`/health` 反向代理到后端）。

## 可用脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev:server` | 以 `tsx watch` 热重载启动后端 |
| `npm run dev:client` | 启动 Vite 开发服务器 |
| `npm run build` | 构建所有子包（含 TypeScript 编译） |
| `npm run db:push` | 将 Prisma schema 同步到数据库 |
| `npm run db:generate` | 生成 Prisma Client（类型安全的数据库访问层） |
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
| POST / GET | `/export/:id/:format` | 导出文件，`format` 为 `docx` 或 `pdf`；POST 可带 `{ pageBreakIds }` 复用预览分页断点（GET 为无断点的兼容写法） |
| GET | `/ai/health` | LLM 是否可用 / 当前生效配置摘要 |
| GET | `/ai/config` | 模型配置列表（全部 Profile + 当前激活项）与生效配置摘要 |
| POST | `/ai/config` | 增删改选模型 Profile，body：`{ action: 'add'\|'update'\|'remove'\|'setActive'\|'clear', ... }` |
| DELETE | `/ai/config` | 清空所有模型 Profile（回退到 `.env` 配置） |
| GET | `/ai/calls/latest` | 最近一次 LLM 调用日志（kind / provider / model / ok / reasoning / output） |
| POST | `/ai/analyze` | 简历分析；`streaming:true` 时返回 SSE（逐字思考过程 + 输出内容），带 `jd` 做岗位匹配，带 `resumeId` 结果落库 |
| PATCH | `/ai/analyze/:resumeId/applied` | 把分析结果中某条建议标记为「已应用」（body：`{ section, index }`，写回 `Resume.analysis`） |
| POST | `/import/parse` | 上传 `.docx`/`.pdf` 解析为结构化内容（multipart，≤20MB），SSE 返回识别过程 |

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
- **分页一致性**：预览会计算分页断点（块级 id）并在导出请求中提交，导出端在这些块前插入硬分页，使导出文件的每页内容与网页预览一致。

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

本项目基于 [MIT License](./LICENSE) 开源。
