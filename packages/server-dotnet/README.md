# resume-agent server（.NET 10 复刻版）

以 .NET 10 + ASP.NET Core + EF Core + Microsoft.Extensions.AI 复刻 `packages/server`（Fastify 版）的全部端点，**端点契约与 Node 版逐一对应，前端零改动**。

## 启动

```bash
# 一键启动（.NET 后端 :4000 + Vite 前端 :5173，自动加载根目录 .env）
start-dotnet.bat

# 或仅启动后端
npm run dev:server:dotnet        # 监听 http://localhost:4000（与 Node 版一致）
# 或
cd packages/server-dotnet/ResumeAgent.Api && dotnet run
```

- 端口：**与 Node 版完全一致**（读 `PORT`，默认 4000）。两个后端不可同时运行，切换时先停掉另一个。
- 环境变量：由 `dev.ps1` 加载根目录 `.env` 的 `DATABASE_URL` / `JWT_SECRET` / `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` / `CLIENT_ORIGIN`。
- 数据库：EF Core 通过 `Data/AppDbContext.cs` 显式映射现有 Prisma 表（`User` / `AiModelProfile` / `LlmCallLog` / `Resume`），**只读不迁移**——迁移主权仍在 Prisma 侧。

## 模块对照

| Node 版 | .NET 版 | 说明 |
|---|---|---|
| `modules/auth.ts` | `Endpoints/AuthEndpoints.cs` | JWT（JwtBearer）+ BCrypt |
| `modules/resume.ts` | `Endpoints/ResumeEndpoints.cs` | CRUD，删除时事务清理调用日志 |
| `modules/ai.ts` | `Endpoints/AiEndpoints.cs` + `Services/Analysis/` | 硬规则 + LLM 分析、归一化/防编造过滤、缓存、SSE |
| `modules/import.ts` | `Endpoints/ImportEndpoints.cs` + `Services/Import/` | docx/pdf 抽取、OCR、脱敏、结构化 |
| `modules/export.ts` | `Endpoints/ExportEndpoints.cs` + `Services/Export/` | DOCX（OpenXml）+ PDF（QuestPDF） |
| `services/llm.ts` | `Services/Llm/` | Microsoft.Extensions.AI `IChatClient` + provider 策略 |

## 与 Node 版的行为差异（有意为之）

1. **PDF 主路径换成 QuestPDF**（不再依赖本机 Word COM），排版基于同一套 `PRINT` 令牌复刻 pdfkit 降级布局：
   - 行距经校准对齐 Word 渲染（`Print.PdfLineRatio = 1.9`，实测 Word 10pt@1.5 倍行距 = 21.5pt/行）；
   - `pageBreakIds` 仅保留契约兼容，实际由 QuestPDF 自然分页（与 Node 版 Word 主路径行为一致——`docx.ts` 也未使用分页断点；硬分页会与预览度量错位造成大面积留白）。
2. **LLM 层走 M.E.AI 抽象 + 原始 SSE 兼容层分流**：
   - `openai` provider：M.E.AI `IChatClient`（OpenAI 官方协议）；
   - 其他 OpenAI 兼容 provider（deepseek/doubao/qwen/vllm/lmstudio/ollama）流式调用走 `RawOpenAiStream`——OpenAI .NET SDK 会在模型绑定阶段丢弃第三方端点 delta 里的 `reasoning_content`（思考过程），原始 SSE 解析才能保留推理流；provider 策略（json_schema / json_object / 行内 JSON 提示）保留在 `ChatService.ResolveFormat`。
3. OCR 仍复用 `packages/server/scripts/ocr.py`（conda + rapidocr），`OcrRunner` 通过 `Process` 调用，行为一致。
4. DOCX 行内标题（职位 · 公司 + 右侧日期）用 **1 行 2 列嵌套表格**实现（TS 版是 RIGHT tab 制表位）：左侧标题过长时正常折行，日期固定宽度右对齐——tab 方案在标题宽度达到制表位时会把日期推出文字区造成遮挡。
5. LLM 分析结果的归一化对模型输出的键名多变体做了兼容（分组名 `section/name/sectionName`、大小写、`field` 与 `section` 并存时优先真实字段路径），field 统一小写以匹配前端 camelCase 定位。

## 调试工具（`debug/`，不入库）

| 工具 | 用途 |
|---|---|
| `render-pdf-pages.cjs` | 把 PDF 每页渲染成 PNG，视觉检查排版 |
| `compare-pdf.cjs` | 对比两份 PDF 的字体（/BaseFont）与字号分布 |
| `measure-pitch.cjs` | 测量 PDF 相邻正文行距（行距校准用） |
| `docx2pdf.ps1` | 调用本机 Word COM 把 DOCX 转 PDF（验证 DOCX 排版） |
| `smoke-*.json` | 冒烟/边界测试用的简历数据（长内容、双栏超长文本等） |

依赖仓库根目录的 `node_modules`（pdfjs-dist、@napi-rs/canvas，复用 Node 版依赖）。示例：

```bash
node debug/render-pdf-pages.cjs 导出.pdf page   # 生成 page-1.png、page-2.png...
powershell -File debug/docx2pdf.ps1 -InPath a.docx -OutPath a.pdf
```

## 已知注意点

- Pomelo 当前主线为 net8/net9，net10 上运行正常；若后续 EF Core 10 稳定可升级 Pomelo。
- QuestPDF 字体从 `C:\Windows\Fonts` 注册（STSONG → msyh → simsun），部署到 Linux 需携带字体文件。
- 推理模型（如 qwen3.8-flash）完整分析一轮约 1~3 分钟（思考 + 生成长 JSON），前端请求超时需覆盖此时长。
