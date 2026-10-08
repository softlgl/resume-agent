// 思考（reasoning / thinking）开关：按 provider 注入各家非标准扩展参数（对齐 modules/ai/core/llm.ts 的 applyThinkingMode）
//
// 三态语义：
// - follow：不注入任何参数，保持各家默认行为（即改造前的基线）
// - on / off：只在该 provider 该参数确认可用时注入，未确认的一律静默忽略，避免把请求打成 400
// 各家字段名与取值都不同（enable_thinking / thinking.type / think / chat_template_kwargs / reasoning_effort），
// 且都放在请求体顶层，因此统一在原始 HTTP 请求体这一个出口注入。

namespace ResumeAgent.Api.Services.Llm;

public static class LlmThinking
{
    /// <summary>openai 官方只有推理模型接受 reasoning_effort，gpt-4o 等传了会 400</summary>
    private static bool IsOpenAiReasoningModel(string model) =>
        model.StartsWith("gpt-5", StringComparison.OrdinalIgnoreCase) ||
        model.StartsWith("o1", StringComparison.OrdinalIgnoreCase) ||
        model.StartsWith("o3", StringComparison.OrdinalIgnoreCase) ||
        model.StartsWith("o4", StringComparison.OrdinalIgnoreCase);

    /// <summary>取值归一：只接受 on/off，其余（含 null 与旧数据）一律回落 follow</summary>
    public static string Normalize(string? mode) => mode is "on" or "off" ? mode : "follow";

    /// <summary>本次要注入的参数；null 表示不注入（follow 或该 provider 无可靠参数）</summary>
    private sealed record ThinkingSpec(
        bool? EnableThinking = null, string? ThinkingType = null,
        bool? Think = null, bool? TemplateEnableThinking = null, string? ReasoningEffort = null);

    private static ThinkingSpec? Resolve(LlmConfig cfg)
    {
        var mode = Normalize(cfg.ThinkingMode);
        if (mode == "follow") return null;
        var on = mode == "on";
        return cfg.Provider switch
        {
            LlmProvider.Qwen => new ThinkingSpec(EnableThinking: on),
            LlmProvider.Deepseek or LlmProvider.Doubao =>
                new ThinkingSpec(ThinkingType: on ? "enabled" : "disabled"),
            LlmProvider.Vllm => new ThinkingSpec(TemplateEnableThinking: on),
            LlmProvider.Ollama => new ThinkingSpec(Think: on),
            LlmProvider.Openai when IsOpenAiReasoningModel(cfg.Model) =>
                new ThinkingSpec(ReasoningEffort: on ? "low" : "none"),
            _ => null, // lmstudio 等无可靠参数：等同跟随默认
        };
    }

    /// <summary>请求体注入（RawOpenAiStream 走这条）</summary>
    public static OpenAiChatRequest Apply(OpenAiChatRequest body, LlmConfig cfg)
    {
        var spec = Resolve(cfg);
        if (spec is null) return body;
        return body with
        {
            EnableThinking = spec.EnableThinking,
            Think = spec.Think,
            ReasoningEffort = spec.ReasoningEffort,
            Thinking = spec.ThinkingType is null ? null : new OpenAiThinking(spec.ThinkingType),
            ChatTemplateKwargs = spec.TemplateEnableThinking is null
                ? null
                : new OpenAiChatTemplateKwargs(spec.TemplateEnableThinking.Value),
        };
    }
}
