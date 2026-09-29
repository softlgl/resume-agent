// 简历模板清单与排版小工具（packages/shared/src/templates.ts 的 C# 镜像）

using System.Text.RegularExpressions;
using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Services.Export;

public static class Templates
{
    private static readonly string[] OrderDefault = ["summary", "works", "educations", "projects", "skills"];

    public static readonly List<TemplateConfig> All =
    [
        new()
        {
            Id = "classic", Name = "经典单栏", Description = "稳重专业的单栏布局，适合传统行业与大多数岗位。",
            Layout = "single",
            Colors = new TemplateColors { Primary = "#1E3A8A", Accent = "#2563EB", Text = "#0F172A", Muted = "#475569", Line = "#CBD5E1" },
            FontFamily = "PingFang SC, Microsoft YaHei, sans-serif", HeadingWeight = 700, SidebarBasic = false,
            SectionOrder = OrderDefault,
        },
        new()
        {
            Id = "modern", Name = "现代双栏", Description = "左侧信息栏 + 右侧内容的现代双栏结构，突出基本信息。",
            Layout = "two-column",
            Colors = new TemplateColors { Primary = "#0F172A", Accent = "#2563EB", Sidebar = "#1E293B", Text = "#0F172A", Muted = "#475569", Line = "#E2E8F0" },
            FontFamily = "PingFang SC, Microsoft YaHei, sans-serif", HeadingWeight = 700, SidebarBasic = true,
            SectionOrder = OrderDefault,
        },
        new()
        {
            Id = "minimal", Name = "极简留白", Description = "大量留白与细线条，清爽极简，适合设计/创意岗位。",
            Layout = "single",
            Colors = new TemplateColors { Primary = "#111827", Accent = "#6B7280", Text = "#111827", Muted = "#6B7280", Line = "#E5E7EB" },
            FontFamily = "PingFang SC, Microsoft YaHei, sans-serif", HeadingWeight = 600, SidebarBasic = false,
            SectionOrder = OrderDefault,
        },
        new()
        {
            Id = "tech", Name = "科技蓝", Description = "高饱和蓝色调，强调技能与技术栈，适合工程师岗位。",
            Layout = "two-column",
            Colors = new TemplateColors { Primary = "#0369A1", Accent = "#0EA5E9", Sidebar = "#0C4A6E", Text = "#0F172A", Muted = "#475569", Line = "#BAE6FD" },
            FontFamily = "PingFang SC, Microsoft YaHei, sans-serif", HeadingWeight = 700, SidebarBasic = true,
            SectionOrder = ["skills", "works", "projects", "educations", "summary"],
        },
        new()
        {
            Id = "elegant", Name = "优雅紫", Description = "柔和紫色调，优雅精致，适合产品/运营/市场岗位。",
            Layout = "single",
            Colors = new TemplateColors { Primary = "#6D28D9", Accent = "#A855F7", Text = "#1E1B4B", Muted = "#6B7280", Line = "#DDD6FE" },
            FontFamily = "PingFang SC, Microsoft YaHei, sans-serif", HeadingWeight = 700, SidebarBasic = false,
            SectionOrder = ["summary", "works", "projects", "educations", "skills"],
        },
        new()
        {
            Id = "green", Name = "清新绿", Description = "自然清新绿色调，适合教育/医疗/公益等行业。",
            Layout = "two-column",
            Colors = new TemplateColors { Primary = "#15803D", Accent = "#22C55E", Sidebar = "#14532D", Text = "#0F172A", Muted = "#475569", Line = "#BBF7D0" },
            FontFamily = "PingFang SC, Microsoft YaHei, sans-serif", HeadingWeight = 700, SidebarBasic = true,
            SectionOrder = ["summary", "educations", "works", "projects", "skills"],
        },
    ];

    public static TemplateConfig Get(string id) =>
        All.FirstOrDefault(t => t.Id == id) ?? All[0];

    // ---- 小工具（三端共用语义） ----

    /// <summary>把技能字符串拆成数组</summary>
    public static List<string> SplitSkills(string items) =>
        Regex.Split(items ?? "", @"[,\n，]")
            .Select(s => s.Trim())
            .Where(s => s.Length > 0)
            .ToList();

    /// <summary>把 #RRGGBB 主色按 alpha 混白，返回不透明的浅色 hex（预览/PDF/DOCX 颜色一致）</summary>
    public static string Soften(string hex, double alpha)
    {
        var h = hex.TrimStart('#');
        var r = Convert.ToInt32(h[..2], 16);
        var g = Convert.ToInt32(h.Substring(2, 2), 16);
        var b = Convert.ToInt32(h.Substring(4, 2), 16);
        int Mix(int c) => (int)Math.Round(c * alpha + 255 * (1 - alpha));
        return $"#{Mix(r):x2}{Mix(g):x2}{Mix(b):x2}";
    }

    /// <summary>根据出生年月（YYYY-MM）计算年龄；无法解析时返回空串</summary>
    public static string CalcAge(string birthday)
    {
        if (string.IsNullOrEmpty(birthday)) return "";
        var m = Regex.Match(birthday.Trim(), @"^(\d{4})-(\d{1,2})");
        if (!m.Success) return "";
        var by = int.Parse(m.Groups[1].Value);
        var bm = int.Parse(m.Groups[2].Value);
        var now = DateTime.Now;
        var age = now.Year - by;
        if (now.Month < bm) age -= 1;
        return age is > 0 and < 120 ? age.ToString() : "";
    }

    /// <summary>去除单行文本开头的列表符号（Markdown 风格 / 中文全角 / 数字编号）</summary>
    public static string StripBullet(string line) =>
        Regex.Replace(line, @"^\s*(?:[-*+•·–—]|\d+[.)])\s*", "");

    /// <summary>按换行拆行 → trim → 去列表前缀 → 过滤空行。工作/项目描述专用。</summary>
    public static List<string> SplitBulletLines(string text)
    {
        if (string.IsNullOrEmpty(text)) return [];
        return text.Split('\n').Select(s => s.Trim()).Where(s => s.Length > 0).Select(StripBullet).ToList();
    }

    /// <summary>按换行拆行 → trim → 过滤空行（普通正文）</summary>
    public static List<string> Lines(string text) =>
        text.Split('\n').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();

    /// <summary>基本信息附加行：出生年月(含年龄)、性别、当前状态、期望薪资、工作年限</summary>
    public static List<string> ExtraLines(BasicInfo b)
    {
        var extra = new List<string>();
        var age = CalcAge(b.Birthday);
        if (b.Birthday.Length > 0) extra.Add($"出生：{b.Birthday}{(age.Length > 0 ? $"（{age}岁）" : "")}");
        if (b.Gender.Length > 0) extra.Add($"性别：{b.Gender}");
        if (b.CurrentStatus.Length > 0) extra.Add($"状态：{b.CurrentStatus}");
        if (b.ExpectedSalary.Length > 0) extra.Add($"期望薪资：{b.ExpectedSalary}");
        if (b.WorkYears.Length > 0) extra.Add($"工作年限：{b.WorkYears}");
        return extra;
    }
}
