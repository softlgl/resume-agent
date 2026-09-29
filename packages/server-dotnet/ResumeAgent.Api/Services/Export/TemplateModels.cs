// 简历模板的配色与配置模型（packages/shared/src/templates.ts 的 C# 镜像）

namespace ResumeAgent.Api.Services.Export;

public sealed class TemplateColors
{
    public string Primary { get; init; } = "";
    public string Accent { get; init; } = "";
    public string? Sidebar { get; init; }
    public string Text { get; init; } = "";
    public string Muted { get; init; } = "";
    public string Line { get; init; } = "";
}

public sealed class TemplateConfig
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Description { get; init; } = "";
    public string Layout { get; init; } = "single"; // "single" | "two-column"
    public TemplateColors Colors { get; init; } = new();
    public string FontFamily { get; init; } = "";
    public int HeadingWeight { get; init; }
    public bool SidebarBasic { get; init; }
    public string[] SectionOrder { get; init; } = [];
}