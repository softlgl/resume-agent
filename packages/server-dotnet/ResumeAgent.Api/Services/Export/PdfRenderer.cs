// PDF 渲染（QuestPDF 主路径，复刻 export/pdf.ts 的 pdfkit 布局语义）
// - 同一套 PRINT 排版令牌，与预览/DOCX 视觉一致
// - pageBreakIds：在这些块起始处强制换页（对齐前端预览分页）
// - 技能胶囊用 Inlined 容器自动换行（等价 pdfkit 手动折行逻辑）

using QuestPDF.Drawing;
using QuestPDF.Fluent;
using QuestPDF.Helpers;
using QuestPDF.Infrastructure;
using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Services.Export;

public static class PdfRenderer
{
    static PdfRenderer()
    {
        QuestPDF.Settings.License = LicenseType.Community;
        RegisterCjkFont();
    }

    // 注册 CJK 字体（优先华文宋体，与 TS 版 FONT_PATH 一致；失败回退雅黑/宋体）
    private static void RegisterCjkFont()
    {
        foreach (var (file, family) in new[] { ("STSONG.TTF", "STSong"), ("msyh.ttf", "Microsoft YaHei"), ("msyh.ttc", "Microsoft YaHei"), ("simsun.ttc", "SimSun") })
        {
            try
            {
                var path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts", file);
                if (!File.Exists(path)) continue;
                FontManager.RegisterFontFromFile(path);
                _fontFamily = family;
                return;
            }
            catch
            {
                // 尝试下一个候选字体
            }
        }
    }

    private static string? _fontFamily;

    private static TextSpanDescriptor Styled(this TextSpanDescriptor span, string color, double size, bool bold = false)
    {
        span.FontColor(color).FontSize((float)size);
        if (bold) span.Bold();
        if (_fontFamily is not null) span.FontFamily(_fontFamily);
        return span;
    }

    public static byte[] Render(ResumeContent content, string templateId, IReadOnlyList<string> pageBreakIds)
    {
        var tpl = Templates.Get(templateId);
        var c = tpl.Colors;
        var b = content.Basic;
        var extra = Templates.ExtraLines(b);

        var twoCol = tpl.Layout == "two-column" && tpl.SidebarBasic;

        var doc = Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Size(PageSizes.A4);
                page.Margin(0);
                page.PageColor("#FFFFFF");
                page.DefaultTextStyle(t =>
                {
                    if (_fontFamily is not null) t.FontFamily(_fontFamily);
                    return t;
                });

                if (twoCol)
                {
                    page.Content().Row(row =>
                    {
                        // 侧栏：深色底铺满页高
                        row.ConstantItem((float)Print.SidebarWidth).MinHeight((float)Print.PageHeight)
                            .Background(c.Sidebar ?? "#1E293B")
                            .PaddingHorizontal((float)Print.SidebarPad)
                            .PaddingVertical(40)
                            .Column(side =>
                            {
                                side.Item().PaddingBottom(Print.SideNameAfter)
                                    .Text(b.Name.Length > 0 ? b.Name : "姓名")
                                    .Styled("#FFFFFF", Print.SidebarName, bold: true);
                                if (b.Title.Length > 0)
                                    side.Item().PaddingBottom(Print.SideTitleAfter)
                                        .Text(b.Title).Styled("#93C5FD", Print.SidebarTitle);
                                side.Spacing(2);
                                side.Item().PaddingTop(Print.SideLabelBefore).PaddingBottom(Print.SideLabelAfter)
                                    .Text("联系方式").Styled("#FFFFFF", Print.SidebarLabel, bold: true);
                                if (b.Phone.Length > 0) SideField(side, $"电话：{b.Phone}");
                                if (b.Email.Length > 0) SideField(side, $"邮箱：{b.Email}");
                                if (b.Location.Length > 0) SideField(side, $"地址：{b.Location}");
                                if (b.Website.Length > 0) SideField(side, $"主页：{b.Website}");
                                foreach (var l in extra) SideField(side, l);
                            });

                        // 主区
                        row.RelativeItem()
                            .PaddingHorizontal((float)Print.Margin)
                            .PaddingVertical((float)Print.Margin)
                            .Column(main => RenderMain(main, tpl, content, extra));
                    });
                }
                else
                {
                    page.Content().PaddingVertical((float)Print.Margin).PaddingHorizontal((float)Print.Margin)
                        .Column(main => RenderMain(main, tpl, content, extra, headerBand: true));
                }
            });
        });

        return doc.GeneratePdf();
    }

    private static void SideField(ColumnDescriptor col, string line) =>
        col.Item().PaddingBottom(Print.SideFieldAfter).Text(line).Styled("#E2E8F0", Print.SidebarField);

    // 主区渲染（双栏/单栏共用；单栏额外渲染姓名头部软底带）
    private static void RenderMain(
        ColumnDescriptor col, TemplateConfig tpl, ResumeContent content,
        List<string> extra, bool headerBand = false)
    {
        var c = tpl.Colors;
        var b = content.Basic;
        var firstSection = true;

        void MaybeBreak(string id)
        {
            // 对齐 Node 版 Word COM 主路径行为（docx.ts 未使用 pageBreakIds，分页由渲染器自然决定）。
            // 若在此执行硬分页 PageBreak()，前端预览分页点（基于浏览器 15pt/行度量）与
            // QuestPDF 自然分页（21pt/行）不吻合，会导致每页下部大面积留白、页数膨胀。
            // 参数保留以兼容契约，等待后续如需"逐页对齐预览"再做软分页（EnsureSpace 类方案）。
        }

        if (headerBand)
        {
            // 姓名头部软底带（ soften 8% 主色，与预览/DOCX 一致）
            var soft = Templates.Soften(c.Primary, 0.08);
            var hasHeader = true;
            var contact = string.Join("  |  ", new[] { b.Phone, b.Email, b.Location, b.Website }.Where(s => s.Length > 0));
            var band = new List<Action<ColumnDescriptor>>
            {
                ccol => ccol.Item().PaddingBottom(Print.NameAfter).Text(b.Name.Length > 0 ? b.Name : "姓名").Styled(c.Primary, Print.Name, bold: true),
            };
            if (b.Title.Length > 0)
                band.Add(ccol => ccol.Item().PaddingBottom(Print.TitleAfter).Text(b.Title).Styled(c.Muted, Print.Title));
            if (contact.Length > 0)
                band.Add(ccol => ccol.Item().PaddingBottom(Print.ContactAfter).Text(contact).Styled(c.Muted, Print.Small));
            if (extra.Count > 0)
                band.Add(ccol => ccol.Item().PaddingBottom(Print.ExtraAfter).Text(string.Join("  |  ", extra)).Styled(c.Muted, Print.Small));

            col.Item().Background(soft).PaddingHorizontal(Print.SectionBefore).PaddingVertical(Print.NameAfter)
                .Column(bcol =>
                {
                    foreach (var add in band) add(bcol);
                    if (band.Count == 1 && b.Title.Length == 0 && contact.Length == 0 && extra.Count == 0) hasHeader = false;
                });
            _ = hasHeader;
            col.Item().PaddingBottom(Print.BlockAfter);
        }

        void SectionTitle(string txt)
        {
            // 对齐 DOCX 间距语义：章节标题前 = sectionBefore(10) + 非首章节叠加 blockAfter(8)。
            // 不要把标题行高算进前置间距（行盒自身占位），否则每章节前凭空多出 ~20pt 留白。
            var before = Print.SectionBefore + (firstSection ? 0 : Print.BlockAfter);
            firstSection = false;
            col.Item().PaddingTop(before)
                .BorderBottom(0.5f).BorderColor(c.Line)
                .Row(row =>
                {
                    row.ConstantItem(4).Height((float)Print.SectionTitle).Background(c.Primary);
                    row.RelativeItem().PaddingLeft((float)(Print.BulletAfter + Print.LineGap))
                        .Text(txt).Styled(c.Primary, Print.SectionTitle, bold: true);
                });
            col.Item().PaddingBottom(Print.SectionAfter);
        }

        void Body(string str, double size = Print.Body, string? color = null)
        {
            col.Item().PaddingBottom(Print.BodyAfter)
                .Text(str).Styled(color ?? c.Text, size).LineHeight(Print.PdfLineRatio);
        }

        void Bullet(string str)
        {
            col.Item().PaddingBottom(Print.BulletAfter).PaddingLeft((float)(Print.BulletAfter + Print.LineGap))
                .Text($"- {str}").Styled(c.Text, Print.Bullet).LineHeight(Print.PdfLineRatio);
        }

        void InlineTitle(string leftStr, string rightStr, bool firstInBlock)
        {
            var leftSize = Print.Body * Print.InlineTitleScale;
            // 对齐 DOCX：非首条目前置 blockAfter(8)（与上一条目最后段落的 bulletAfter 叠加为 10pt）
            col.Item().PaddingTop(firstInBlock ? 0 : Print.BlockAfter).Row(row =>
            {
                // 左标题占满剩余宽度；右侧日期用 AutoItem（自然宽度）贴右缘——
                // 若日期也用 RelativeItem 会把标题压到半宽导致换行、行间出现大空隙
                row.RelativeItem().Text(leftStr).Styled(c.Text, leftSize, bold: true).LineHeight(Print.PdfLineRatio);
                row.AutoItem().AlignRight()
                    .Text(rightStr).Styled(c.Muted, Print.Small);
            });
            col.Item().PaddingBottom(2);
        }

        void SkillRow(SkillGroup g)
        {
            var softBg = Templates.Soften(c.Primary, 0.08);
            col.Item().Row(row =>
            {
                row.AutoItem().PaddingTop((float)(Print.Bullet * 0.1))
                    .Text($"{g.Category} ：").Styled(c.Text, Print.Body, bold: true);
                row.RelativeItem().PaddingLeft(6)
                    .Inlined(inl =>
                    {
                        inl.Spacing(4);
                        foreach (var s in Templates.SplitSkills(g.Items))
                        {
                            inl.Item().Background(softBg).PaddingHorizontal(2).PaddingVertical(1)
                                .Text(s).Styled(c.Primary, Print.Bullet);
                        }
                    });
            });
            col.Item().PaddingBottom(Print.BodyAfter);
        }

        void RenderSection(string key)
        {
            switch (key)
            {
                case "summary":
                    if (content.Basic.Summary.Length == 0) return;
                    MaybeBreak("summary#title");
                    SectionTitle("个人简介");
                    {
                        var linesList = Templates.Lines(content.Basic.Summary);
                        for (var i = 0; i < linesList.Count; i++)
                        {
                            MaybeBreak($"summary#{i}");
                            Body(linesList[i]);
                        }
                    }
                    break;
                case "works":
                    if (content.Works.Count == 0) return;
                    MaybeBreak("works#title");
                    SectionTitle("工作经历");
                    for (var i = 0; i < content.Works.Count; i++)
                    {
                        var w = content.Works[i];
                        MaybeBreak($"works#{i}");
                        InlineTitle($"{w.Role} · {w.Company}", $"{w.Start} - {(w.Current ? "至今" : w.End)}", i == 0);
                        foreach (var l in Templates.SplitBulletLines(w.Description))
                            if (Templates.SplitBulletLines(w.Description).Count > 1) Bullet(l); else Body(l);
                    }
                    break;
                case "educations":
                    if (content.Educations.Count == 0) return;
                    MaybeBreak("educations#title");
                    SectionTitle("教育经历");
                    for (var i = 0; i < content.Educations.Count; i++)
                    {
                        var e = content.Educations[i];
                        MaybeBreak($"educations#{i}");
                        InlineTitle($"{e.School} · {e.Major} · {e.Degree}", $"{e.Start} - {e.End}", i == 0);
                        if (e.Description.Length > 0)
                            foreach (var l in Templates.Lines(e.Description)) Body(l);
                    }
                    break;
                case "projects":
                    if (content.Projects.Count == 0) return;
                    MaybeBreak("projects#title");
                    SectionTitle("项目经历");
                    for (var i = 0; i < content.Projects.Count; i++)
                    {
                        var p = content.Projects[i];
                        MaybeBreak($"projects#{i}");
                        InlineTitle($"{p.Name}{(p.Company.Length > 0 ? $" · {p.Company}" : "")} · {p.Role}", $"{p.Start} - {p.End}", i == 0);
                        if (p.Link.Length > 0)
                            col.Item().PaddingBottom(Print.BulletAfter)
                                .Text(p.Link).Styled(c.Accent, Print.Small);
                        foreach (var l in Templates.SplitBulletLines(p.Description))
                            if (Templates.SplitBulletLines(p.Description).Count > 1) Bullet(l); else Body(l);
                    }
                    break;
                case "skills":
                    if (content.Skills.Count == 0) return;
                    MaybeBreak("skills#title");
                    SectionTitle("技能");
                    for (var i = 0; i < content.Skills.Count; i++)
                    {
                        MaybeBreak($"skills#{i}");
                        SkillRow(content.Skills[i]);
                    }
                    break;
            }
        }

        foreach (var k in tpl.SectionOrder) RenderSection(k);
    }
}
