// /ai/chat 与 /ai/revisions 模块（对齐 modules/ai/chat.ts）：
// - 会话 CRUD + 多轮对话（SSE 流式）
// - AI 产出的修改建议经 Services/Edit/ResumeEditValidator 权威校验后下发给前端
// - 统一修订账本（AiRevision）：对话侧与分析侧共用的撤销依据
// 设计约束：本模块不提供任何「直接改简历字段」的接口，写入永远由前端 applyEdit 完成。
//
// 本文件只负责挂路由，三块实现各在一个文件：ChatSessionEndpoints / ChatMessageEndpoints /
// RevisionEndpoints；公共装配层见 Services/Ai/ChatProjection.cs、ChatAudit.cs、ChatPrompts.cs。

using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ResumeAgent.Api.Auth;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Data;
using ResumeAgent.Api.Services.Ai;
using ResumeAgent.Api.Services.Edit;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Endpoints.Ai;

public static class AiChatEndpoints
{
    public static IEndpointRouteBuilder MapAiChatEndpoints(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/ai").RequireAuthorization();

        ChatSessionEndpoints.Map(g);
        ChatMessageEndpoints.Map(g);
        RevisionEndpoints.Map(g);

        return app;
    }
}
