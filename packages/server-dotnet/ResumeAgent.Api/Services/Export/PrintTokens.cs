// 统一排版令牌（PRINT）：预览 / PDF / DOCX 共用，保证视觉一致（pt 基准）
// 单位约定：字号、边距一律用「磅 pt」。A4 = 210mm × 297mm = 595.28 × 841.89 pt。
// PDF 直接使用；DOCX 的 size 是 half-point（×2），间距 twips（×20）。

namespace ResumeAgent.Api.Services.Export;

public static class PrintTokens
{
    public const float PageWidth = 595.28f;
    public const float PageHeight = 841.89f;
    public const float Margin = 40;          // 单栏页边距
    public const float SidebarPad = 24;      // 双栏侧边栏内边距（左右）
    public const float SidebarWidth = 160;   // 双栏侧边栏宽度（约占 27%）

    // 字号（pt）
    public const float Name = 22;            // 姓名（单栏标题）
    public const float Title = 13;           // 职位副标题
    public const float SectionTitle = 13;    // 章节标题
    public const float Body = 10;            // 正文
    public const float Bullet = 10;          // 列表项正文
    public const float Small = 9.5f;         // 联系方式 / 附加信息
    public const float SidebarName = 18;     // 侧边栏姓名
    public const float SidebarTitle = 11;    // 侧边栏职位
    public const float SidebarLabel = 12;    // 侧边栏分节标题
    public const float SidebarField = 9;     // 侧边栏字段

    // 间距令牌（pt 基准）
    public const float LineHeight = 1.5f;     // 文本行高倍数（预览/DOCX 语义：1.5 × 字体单倍行距）
    // PDF 行高比率（QuestPDF 专用）：QuestPDF 的 LineHeight 基于字体自然行盒（STSong ≈1.13em），
    // 而 Word 的 1.5 倍行距基于 SimSun 度量（≈1.43em）——实测 Word 10pt@1.5 = 21.5pt，
    // QuestPDF 需 1.5 × 21.5/17 ≈ 1.9 才能得到相同行距，否则 PDF 文字明显比 Word 版紧凑
    public const float PdfLineRatio = 1.9f;
    public const float LineGap = 2;           // 文本行额外间距
    public const float BodyAfter = 4;         // 正文段后
    public const float BulletAfter = 2;       // 列表项段后
    public const float BlockAfter = 8;        // 条目块整体下方间距
    public const float SectionBefore = 10;    // 章节标题前
    public const float SectionAfter = 6;      // 章节标题后
    public const float NameAfter = 6;         // 单栏姓名下方
    public const float TitleAfter = 8;        // 单栏副标题下方
    public const float ContactAfter = 6;      // 单栏联系方式下方
    public const float ExtraAfter = 6;        // 单栏附加信息下方
    public const float SideNameAfter = 6;     // 侧栏姓名下方
    public const float SideTitleAfter = 10;   // 侧栏副标题下方
    public const float SideLabelBefore = 12;  // 侧栏分节标题前
    public const float SideLabelAfter = 4;    // 侧栏分节标题后
    public const float SideFieldAfter = 2;    // 侧栏字段后
    public const float SectionLineOffset = 1.3f; // 章节标题下划线相对字号倍数偏移
    public const float InlineTitleScale = 1.15f; // 条目内标题字号相对 Body 的倍数

    public static int HalfPt(double pt) => (int)Math.Round(pt * 2);  // DOCX 字号 half-point
    public static int Tw(double pt) => (int)Math.Round(pt * 20);     // pt → twips
}