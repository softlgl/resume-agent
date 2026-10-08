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
| `modules/ai/analyze.ts` | `Endpoints/Ai/AiAnalyzeEndpoints.cs` + `Services/Analysis/` | 硬规则 + LLM 分析、归一化/防编造过滤、缓存、SSE |
| `modules/ai/config.ts` | `Endpoints/Ai/AiConfigEndpoints.cs` | 多模型 Profile 的增删改选与内存快照 |
| `modules/ai/chat.ts` | `Endpoints/Ai/AiChatEndpoints.cs`（只挂路由）+ `ChatSessionEndpoints.cs` / `ChatMessageEndpoints.cs` / `RevisionEndpoints.cs`，共用 `Services/Ai/ChatProjection.cs`、`ChatAudit.cs`、`ChatPrompts.cs` | AI 对话、修改建议校验与修改账本 |
| `modules/ai/interview.ts` | `Endpoints/Ai/AiInterviewEndpoints.cs` + `Services/Ai/InterviewHistory.cs`、`Services/Ai/InterviewPrompts.cs` | 模拟面试：计划 / 判定 / 追问 / 报告（契约见 `Contracts/AiInterviewContracts.cs`） |
| `modules/ai/import.ts` | `Endpoints/Ai/ImportEndpoints.cs` + `Services/Import/` | docx/pdf 抽取、OCR、脱敏、结构化 |
| `modules/export.ts` | `Endpoints/ExportEndpoints.cs` + `Services/Export/` | DOCX（OpenXml）+ PDF（QuestPDF） |
| `modules/ai/core/*` | `Services/Llm/` + `Services/Ai/` | 同构共享层：`llm`↔`Services/Llm/`、`prompts`/`schemas`/`history`/`call-log`↔`Services/Ai/`（`ChatService` + `RawOpenAiStream` 统一自建请求体，`LlmThinking` 按 provider 注入非标准参数 `enable_thinking` / `thinking.type` / `think` / `chat_template_kwargs` / `reasoning_effort`） |

## 与 Node 版的行为差异（有意为之）

1. **PDF 主路径换成 QuestPDF**（不再依赖本机 Word COM），排版基于同一套 `PRINT` 令牌复刻 pdfkit 降级布局：
   - 行距经校准对齐 Word 渲染（`Print.PdfLineRatio = 1.9`，实测 Word 10pt@1.5 倍行距 = 21.5pt/行）；
   - `pageBreakIds` 仅保留契约兼容，实际由 QuestPDF 自然分页（与 Node 版 Word 主路径行为一致——`docx.ts` 也未使用分页断点；硬分页会与预览度量错位造成大面积留白）。
2. **LLM 层统一走自建请求体 `RawOpenAiStream`**：
   - OpenAI .NET SDK 会在模型绑定阶段丢弃第三方端点 delta 里的 `reasoning_content`（思考过程），也不会把 `ChatOptions.AdditionalProperties` 并入线上请求体——`reasoning_effort` 等非标准参数会被静默吞掉。因此所有 provider（含 `openai`）统一用 `RawOpenAiStream` 自建 `/chat/completions` 请求体，SSE 解析保留完整推理流；
   - 思考开关 `LlmThinking.Apply` 在请求体构造时按 provider 注入各自字段，与 Node 版 `applyThinkingMode` 逻辑逐行对齐；
   - provider 策略（`openai` → `response_format=json_schema`，云端 → `json_object`，本地模型 → 无该字段 + schema 注入提示词）保留在 `ChatService.ResolveResponseFormat` 与 `ChatService.BuildSchemaSystemPrompt`。
3. OCR 仍复用 `packages/server/scripts/ocr.py`（conda + rapidocr），`OcrRunner` 通过 `Process` 调用，行为一致。
4. DOCX 行内标题（职位 · 公司 + 右侧日期）用 **1 行 2 列嵌套表格**实现（TS 版是 RIGHT tab 制表位）：左侧标题过长时正常折行，日期固定宽度右对齐——tab 方案在标题宽度达到制表位时会把日期推出文字区造成遮挡。
5. LLM 分析结果的归一化对模型输出的键名多变体做了兼容（分组名 `section/name/sectionName`、大小写、`field` 与 `section` 并存时优先真实字段路径）。字段路径按**大小写不敏感**收敛到简历 JSON 的真实键（`basic.currentstatus` → `basic.currentStatus`、`Works[0].Description` → `works[0].description`），**不能整体 `ToLower`**：前端按真实键定位字段、按 `FIELD_LABELS` 渲染中文标签，小写化会让卡片显示成「基本信息 · currentstatus」，且「应用改写」会写进一个不存在的键。

## 已知注意点

- Pomelo 当前主线为 net8/net9，net10 上运行正常；若后续 EF Core 10 稳定可升级 Pomelo。
- QuestPDF 字体从 `C:\Windows\Fonts` 注册（STSONG → msyh → simsun），部署到 Linux 需携带字体文件。
- 推理模型（如 qwen3.8-flash）完整分析一轮约 1~3 分钟（思考 + 生成长 JSON），前端请求超时需覆盖此时长。
