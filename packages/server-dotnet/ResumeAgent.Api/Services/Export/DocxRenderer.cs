// DOCX 渲染（docx npm → DocumentFormat.OpenXml 的逐段移植，对齐 export/docx.ts）
// 排版还原要点：
// - 章节标题用「1 行 2 列表格」实现（窄列主色填充=竖条，文字列底边框=下划线）
// - 表格前后用 EXACT 行高空段落占位承载章节间距
// - 双栏布局：全页 0 边距表格，侧栏深色底、主区上下 40pt padding，行高 AT_LEAST + 隐藏尾段
// - 默认字号 1pt（只影响无 TextRun 的隐含段落），正文 run 均显式设置字号

using System.Text;
using DocumentFormat.OpenXml;
using DocumentFormat.OpenXml.Packaging;
using DocumentFormat.OpenXml.Wordprocessing;
using ResumeAgent.Api.Contracts;
using A = DocumentFormat.OpenXml;

namespace ResumeAgent.Api.Services.Export;

public static class DocxRenderer
{
    private static int S(double pt) => Print.HalfPt(pt);
    private static int Tw(double pt) => Print.Tw(pt);
    private static string Hex(string c) => c.TrimStart('#');

    private static Run Tr(string text, bool bold = false, int? size = null, string? color = null, string? shading = null)
    {
        var rPr = new RunProperties();
        rPr.Append(new RunFonts { Ascii = "SimSun", HighAnsi = "SimSun", EastAsia = "SimSun" });
        if (bold) rPr.Append(new Bold());
        if (size is not null) rPr.Append(new FontSize { Val = size.Value.ToString() });
        if (color is not null) rPr.Append(new Color { Val = Hex(color) });
        if (shading is not null)
            // 对齐 docx npm：type=SOLID 时 fill 与 color 都用预混浅色——
            // OOXML 里 val="solid" 表示用 w:color 做 pattern 覆盖 w:fill 底色，
            // color="auto" 会变成黑色 pattern（胶囊变黑底的 bug）
            rPr.Append(new Shading { Val = ShadingPatternValues.Solid, Fill = Hex(shading), Color = Hex(shading) });
        return new Run(rPr, new Text(text) { Space = SpaceProcessingModeValues.Preserve });
    }

    private static SpacingBetweenLines Spacing(double? before = null, double? after = null, int? line = null, bool exact = false)
    {
        var sp = new SpacingBetweenLines
        {
            Before = (before is null ? "0" : Tw(before.Value).ToString()),
            After = (after is null ? "0" : Tw(after.Value).ToString()),
        };
        if (line is not null)
        {
            sp.Line = line.Value.ToString();
            sp.LineRule = exact ? LineSpacingRuleValues.Exact : LineSpacingRuleValues.Auto;
        }
        else
        {
            // 1.5 倍行距（240 * 1.5 = 360），与预览 lineHeight 1.5 对齐
            sp.Line = "360";
            sp.LineRule = LineSpacingRuleValues.Auto;
        }
        return sp;
    }

    private static Paragraph Spacer(double heightPt) => new(
        new ParagraphProperties(Spacing(before: 0, after: 0, line: Tw(heightPt), exact: true)));

    private static Paragraph BodyParagraph(string text, TemplateColors c, string? color = null) => new(
        new ParagraphProperties(Spacing(after: Print.BodyAfter)),
        Tr(text, size: S(Print.Body), color: color ?? c.Text));

    public static byte[] Render(ResumeContent content, string templateId, IReadOnlyList<string> pageBreakIds)
    {
        var tpl = Templates.Get(templateId);
        var c = tpl.Colors;
        var b = content.Basic;
        var extra = Templates.ExtraLines(b);

        var children = new List<OpenXmlElement>();
        bool IsFirst() => children.Count == 0;

        // 章节标题：左竖条 + 下划线（1 行 2 列表格）
        void SectionTitle(string text, bool first)
        {
            // 主内容区宽度（twips）：双栏=主栏宽-主栏单元格左右边距(800×2)；单栏=页宽-左右页边距
            var contentW = tpl.Layout == "two-column" && tpl.SidebarBasic
                ? (int)Math.Round((Print.PageWidth - Print.SidebarWidth) * 20) - 1600
                : (int)Math.Round((Print.PageWidth - Print.Margin * 2) * 20);
            const int barW = 40; // 竖条宽 2pt

            var barCell = new TableCell(
                new TableCellProperties(
                    new TableCellWidth { Width = barW.ToString(), Type = TableWidthUnitValues.Dxa },
                    new Shading { Val = ShadingPatternValues.Clear, Fill = Hex(c.Primary), Color = "auto" },
                    new TableCellMargin(
                        new TopMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                        new TableCellLeftMargin { Width = 0, Type = TableWidthValues.Dxa },
                        new BottomMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                        new TableCellRightMargin { Width = 0, Type = TableWidthValues.Dxa })),
                new Paragraph(new ParagraphProperties(Spacing(before: 0, after: 0, line: 20, exact: true))));

            var textCell = new TableCell(
                new TableCellProperties(
                    new TableCellWidth { Width = (contentW - barW).ToString(), Type = TableWidthUnitValues.Dxa },
                    new TableCellBorders(new BottomBorder { Val = BorderValues.Single, Size = 6U, Color = Hex(c.Line) }),
                    new TableCellMargin(
                        new TopMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                        new TableCellLeftMargin { Width = (short)80, Type = TableWidthValues.Dxa },
                        new BottomMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                        new TableCellRightMargin { Width = (short)0, Type = TableWidthValues.Dxa })),
                // EXACT 15.5pt 行高压紧行高（13pt 宋体加粗可容纳）
                new Paragraph(
                    new ParagraphProperties(Spacing(before: 0, after: 0, line: 310, exact: true)),
                    Tr(text, bold: true, size: S(Print.SectionTitle), color: c.Primary)));

            var table = new Table(
                new TableProperties(
                    new TableWidth { Width = contentW.ToString(), Type = TableWidthUnitValues.Dxa },
                    new TableBorders(
                        new TopBorder { Val = BorderValues.None }, new BottomBorder { Val = BorderValues.None },
                        new LeftBorder { Val = BorderValues.None }, new RightBorder { Val = BorderValues.None },
                        new InsideHorizontalBorder { Val = BorderValues.None }, new InsideVerticalBorder { Val = BorderValues.None }),
                    new TableLayout { Type = TableLayoutValues.Fixed }),
                new TableGrid(new GridColumn { Width = barW.ToString() }, new GridColumn { Width = (contentW - barW).ToString() }),
                new TableRow(barCell, textCell));

            children.Add(Spacer(Print.SectionBefore + (first ? 0 : Print.BlockAfter)));
            children.Add(table);
            children.Add(Spacer(Print.SectionAfter));
        }

        // 条目内标题：左标题右时间
        // 必须用「1 行 2 列嵌套表格」而非 RIGHT tab 制表位：
        // tab 方案在左侧标题宽度达到制表位时，Word 不会折行而是把日期继续向后推，
        // 直到溢出文字区被裁剪/遮盖（双栏窄主栏下必现）。表格左格可正常折行，
        // 右格固定宽度右对齐，日期稳定贴右缘。
        void InlineTitle(string left, string right, bool firstInBlock)
        {
            const int dateW = 1700; // 日期列宽："2022-01 - 2023-06" @9.5pt ≈ 1620 twips，留余量
            var contentW = tpl.Layout == "two-column" && tpl.SidebarBasic
                ? (int)Math.Round((Print.PageWidth - Print.SidebarWidth) * 20) - 1600
                : (int)Math.Round((Print.PageWidth - Print.Margin * 2) * 20);
            var zeroMargin = () => new TableCellMargin(
                new TopMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                new TableCellLeftMargin { Width = (short)0, Type = TableWidthValues.Dxa },
                new BottomMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                new TableCellRightMargin { Width = (short)0, Type = TableWidthValues.Dxa });

            var table = new Table(
                new TableProperties(
                    new TableWidth { Width = contentW.ToString(), Type = TableWidthUnitValues.Dxa },
                    new TableBorders(
                        new TopBorder { Val = BorderValues.None }, new BottomBorder { Val = BorderValues.None },
                        new LeftBorder { Val = BorderValues.None }, new RightBorder { Val = BorderValues.None },
                        new InsideHorizontalBorder { Val = BorderValues.None }, new InsideVerticalBorder { Val = BorderValues.None }),
                    new TableLayout { Type = TableLayoutValues.Fixed }),
                new TableGrid(
                    new GridColumn { Width = (contentW - dateW).ToString() },
                    new GridColumn { Width = dateW.ToString() }),
                new TableRow(
                    new TableCell(
                        new TableCellProperties(
                            new TableCellWidth { Width = (contentW - dateW).ToString(), Type = TableWidthUnitValues.Dxa },
                            zeroMargin(),
                            new TableCellVerticalAlignment { Val = TableVerticalAlignmentValues.Top }),
                        new Paragraph(new ParagraphProperties(Spacing()),
                            Tr(left, bold: true, size: S(Print.Body * Print.InlineTitleScale), color: c.Text))),
                    new TableCell(
                        new TableCellProperties(
                            new TableCellWidth { Width = dateW.ToString(), Type = TableWidthUnitValues.Dxa },
                            zeroMargin(),
                            new TableCellVerticalAlignment { Val = TableVerticalAlignmentValues.Top }),
                        new Paragraph(
                            new ParagraphProperties(
                                new Justification { Val = JustificationValues.Right },
                                Spacing()),
                            Tr(right, size: S(Print.Small), color: c.Muted)))));

            children.Add(Spacer(firstInBlock ? 0 : Print.BlockAfter));
            children.Add(table);
            children.Add(Spacer(Print.BulletAfter));
        }

        void BulletLines(List<string> linesList)
        {
            foreach (var l in linesList)
            {
                var multi = linesList.Count > 1;
                children.Add(new Paragraph(
                    new ParagraphProperties(
                        new Indentation { Left = multi ? "360" : "0" },
                        Spacing(after: Print.BulletAfter)),
                    Tr(multi ? $"- {l}" : l, size: S(multi ? Print.Bullet : Print.Body), color: c.Text)));
            }
        }

        void RenderSection(string key)
        {
            switch (key)
            {
                case "summary":
                    if (content.Basic.Summary.Length == 0) return;
                    SectionTitle("个人简介", IsFirst());
                    foreach (var l in Templates.Lines(content.Basic.Summary)) children.Add(BodyParagraph(l, c));
                    break;
                case "works":
                    if (content.Works.Count == 0) return;
                    SectionTitle("工作经历", IsFirst());
                    for (var i = 0; i < content.Works.Count; i++)
                    {
                        var w = content.Works[i];
                        InlineTitle($"{w.Role} · {w.Company}", $"{w.Start} - {(w.Current ? "至今" : w.End)}", i == 0);
                        BulletLines(Templates.SplitBulletLines(w.Description));
                    }
                    break;
                case "educations":
                    if (content.Educations.Count == 0) return;
                    SectionTitle("教育经历", IsFirst());
                    for (var i = 0; i < content.Educations.Count; i++)
                    {
                        var e = content.Educations[i];
                        InlineTitle($"{e.School} · {e.Major} · {e.Degree}", $"{e.Start} - {e.End}", i == 0);
                        if (e.Description.Length > 0)
                            foreach (var l in Templates.Lines(e.Description)) children.Add(BodyParagraph(l, c));
                    }
                    break;
                case "projects":
                    if (content.Projects.Count == 0) return;
                    SectionTitle("项目经历", IsFirst());
                    for (var i = 0; i < content.Projects.Count; i++)
                    {
                        var p = content.Projects[i];
                        InlineTitle($"{p.Name}{(p.Company.Length > 0 ? $" · {p.Company}" : "")} · {p.Role}", $"{p.Start} - {p.End}", i == 0);
                        if (p.Link.Length > 0) children.Add(BodyParagraph(p.Link, c, c.Accent));
                        BulletLines(Templates.SplitBulletLines(p.Description));
                    }
                    break;
                case "skills":
                    if (content.Skills.Count == 0) return;
                    SectionTitle("技能", IsFirst());
                    foreach (var g in content.Skills)
                    {
                        // 技能胶囊：分类加粗 + 每个技能一个底色 run（与预览/PDF 一致）
                        // 半角空格宽度 = 字号的一半：分类与冒号间 2.5pt（5pt 字号空格），冒号与胶囊间 1pt（2pt 字号空格）
                        var soft = Templates.Soften(c.Primary, 0.08);
                        var pProps = new ParagraphProperties(Spacing(after: Print.BodyAfter));
                        var para = new Paragraph(pProps);
                        para.Append(Tr(g.Category, bold: true, size: S(Print.Body), color: c.Text));
                        para.Append(Tr(" ", size: S(5)));
                        para.Append(Tr("：", bold: true, size: S(Print.Body), color: c.Text));
                        foreach (var s in Templates.SplitSkills(g.Items))
                        {
                            para.Append(Tr(" ", size: S(2)));
                            para.Append(Tr($" {s} ", size: S(Print.Bullet), color: c.Primary, shading: soft));
                        }
                        children.Add(para);
                    }
                    break;
            }
        }

        // ------------------------------------------------------------------
        // 组装 body（双栏表格 / 单栏顺序段落）
        // ------------------------------------------------------------------
        OpenXmlElement[] bodyChildren;
        if (tpl.Layout == "two-column" && tpl.SidebarBasic)
        {
            var sidebarChildren = new List<OpenXmlElement>
            {
                new Paragraph(
                    new ParagraphProperties(Spacing(before: 40, after: Print.SideNameAfter)),
                    Tr(b.Name.Length > 0 ? b.Name : "姓名", bold: true, size: S(Print.SidebarName), color: "FFFFFF")),
            };
            if (b.Title.Length > 0)
                sidebarChildren.Add(new Paragraph(
                    new ParagraphProperties(Spacing(after: Print.SideTitleAfter)),
                    Tr(b.Title, size: S(Print.SidebarTitle), color: "CBD5E1")));
            sidebarChildren.Add(new Paragraph(
                new ParagraphProperties(Spacing(before: Print.SideLabelBefore, after: Print.SideLabelAfter)),
                Tr("联系方式", bold: true, size: S(Print.SidebarLabel), color: "FFFFFF")));
            if (b.Phone.Length > 0) sidebarChildren.Add(SideField($"电话：{b.Phone}"));
            if (b.Email.Length > 0) sidebarChildren.Add(SideField($"邮箱：{b.Email}"));
            if (b.Location.Length > 0) sidebarChildren.Add(SideField($"地址：{b.Location}"));
            if (b.Website.Length > 0) sidebarChildren.Add(SideField($"主页：{b.Website}"));
            foreach (var l in extra) sidebarChildren.Add(SideField(l));

            Paragraph SideField(string t) => new(
                new ParagraphProperties(Spacing(after: Print.SideFieldAfter)),
                Tr(t, size: S(Print.SidebarField), color: "E2E8F0"));

            var mainChildren = new List<OpenXmlElement>();
            foreach (var k in tpl.SectionOrder) RenderSection(k);
            if (children.Count == 0)
                mainChildren.Add(new Paragraph(Tr("（暂无内容）", size: S(Print.Body), color: c.Text)));
            else
                mainChildren.AddRange(children);

            // 侧栏/主区宽度（twips），与 PDF 全页侧栏比例一致
            var sideTw = (int)Math.Round(Print.SidebarWidth * 20);
            var mainTw = (int)Math.Round((Print.PageWidth - Print.SidebarWidth) * 20);
            var tableTw = (int)Math.Round(Print.PageWidth * 20);
            // 主区单元格上下 padding = PRINT.margin；侧栏水平 padding = sidebarPad
            var mainPadV = Print.Margin;
            var sideTwPad = Tw(Print.SidebarPad);
            var sidebarCell = new TableCell(
                new TableCellProperties(
                    new TableCellWidth { Width = sideTw.ToString(), Type = TableWidthUnitValues.Dxa },
                    new Shading { Val = ShadingPatternValues.Clear, Fill = Hex(c.Sidebar ?? "#1E293B"), Color = "auto" },
                    new TableCellMargin(
                        new TopMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                        new TableCellLeftMargin { Width = (short)sideTwPad, Type = TableWidthValues.Dxa },
                        new BottomMargin { Width = "0", Type = TableWidthUnitValues.Dxa },
                        new TableCellRightMargin { Width = (short)sideTwPad, Type = TableWidthValues.Dxa }),
                    new TableCellVerticalAlignment { Val = TableVerticalAlignmentValues.Top }));
            sidebarCell.Append([.. sidebarChildren]);
            var mainCell = new TableCell(
                new TableCellProperties(
                    new TableCellWidth { Width = mainTw.ToString(), Type = TableWidthUnitValues.Dxa },
                    new TableCellMargin(
                        new TopMargin { Width = Tw(mainPadV).ToString(), Type = TableWidthUnitValues.Dxa },
                        new TableCellLeftMargin { Width = (short)800, Type = TableWidthValues.Dxa },
                        new BottomMargin { Width = Tw(mainPadV).ToString(), Type = TableWidthUnitValues.Dxa },
                        new TableCellRightMargin { Width = (short)800, Type = TableWidthValues.Dxa }),
                    new TableCellVerticalAlignment { Val = TableVerticalAlignmentValues.Top }));
            mainCell.Append([.. mainChildren]);

            var pageTw = (int)Math.Round(Print.PageHeight * 20);
            // 表格后「隐藏段落标记」空段落（vanish），防止 Word 自动补默认字号空段导致白边
            var tailPara = new Paragraph(
                new ParagraphProperties(
                    Spacing(before: 0, after: 0, line: 20, exact: true),
                    new ParagraphMarkRunProperties(new Vanish(), new FontSize { Val = "2" })));
            const int reserveTw = 4; // 0.2pt 防舍入余量
            var rowTw = pageTw - reserveTw - Tw(mainPadV) * 2;
            var table = new Table(
                new TableProperties(
                    new TableWidth { Width = tableTw.ToString(), Type = TableWidthUnitValues.Dxa },
                    new TableBorders(
                        new TopBorder { Val = BorderValues.None }, new BottomBorder { Val = BorderValues.None },
                        new LeftBorder { Val = BorderValues.None }, new RightBorder { Val = BorderValues.None },
                        new InsideHorizontalBorder { Val = BorderValues.None }, new InsideVerticalBorder { Val = BorderValues.None }),
                    new TableLayout { Type = TableLayoutValues.Fixed }),
                new TableGrid(new GridColumn { Width = sideTw.ToString() }, new GridColumn { Width = mainTw.ToString() }),
                new TableRow(
                    new TableRowProperties(new TableRowHeight { Val = (UInt32Value)(uint)rowTw, HeightType = HeightRuleValues.AtLeast }),
                    sidebarCell, mainCell));

            bodyChildren = [table, tailPara];
        }
        else
        {
            // 单栏布局——姓名/职位/联系方式/附加信息四段加主色 8% 软底（与预览/PDF 一致）
            var headerShading = Templates.Soften(c.Primary, 0.08);
            ParagraphProperties HeaderProps(double after) => new(
                new Shading { Val = ShadingPatternValues.Solid, Fill = Hex(headerShading), Color = Hex(headerShading) },
                Spacing(after: after));
            children.Clear();
            children.Add(new Paragraph(
                HeaderProps(Print.NameAfter),
                Tr(b.Name.Length > 0 ? b.Name : "姓名", bold: true, size: S(Print.Name), color: c.Primary)));
            if (b.Title.Length > 0)
                children.Add(new Paragraph(
                    HeaderProps(Print.TitleAfter),
                    Tr(b.Title, size: S(Print.Title), color: c.Muted)));
            var contact = string.Join("  |  ", new[] { b.Phone, b.Email, b.Location, b.Website }.Where(s => s.Length > 0));
            if (contact.Length > 0)
                children.Add(new Paragraph(
                    HeaderProps(Print.ContactAfter),
                    Tr(contact, size: S(Print.Small), color: c.Muted)));
            if (extra.Count > 0)
                children.Add(new Paragraph(
                    HeaderProps(Print.ExtraAfter),
                    Tr(string.Join("  |  ", extra), size: S(Print.Small), color: c.Muted)));
            foreach (var k in tpl.SectionOrder) RenderSection(k);
            bodyChildren = [.. children];
        }

        // ------------------------------------------------------------------
        // 打包 docx
        // ------------------------------------------------------------------
        using var ms = new MemoryStream();
        using (var doc = WordprocessingDocument.Create(ms, WordprocessingDocumentType.Document))
        {
            var main = doc.AddMainDocumentPart();
            main.Document = new Document();
            var body = new Body();
            foreach (var el in bodyChildren) body.Append(el);

            // 页面设置：A4；双栏 0 边距（header/footer/gutter 显式归零），单栏 40pt 边距
            var isTwoCol = tpl.Layout == "two-column";
            var secPr = new SectionProperties(
                new PageSize { Width = (UInt32Value)(uint)Math.Round(Print.PageWidth * 20), Height = (UInt32Value)(uint)Math.Round(Print.PageHeight * 20) },
                new PageMargin
                {
                    Top = isTwoCol ? 0 : Tw(Print.Margin),
                    Right = (UInt32Value)(uint)(isTwoCol ? 0 : Tw(Print.Margin)),
                    Bottom = isTwoCol ? 0 : Tw(Print.Margin),
                    Left = (UInt32Value)(uint)(isTwoCol ? 0 : Tw(Print.Margin)),
                    Header = (UInt32Value)0U, Footer = (UInt32Value)0U, Gutter = (UInt32Value)0U,
                });
            body.Append(secPr);
            main.Document.Append(body);

            // 默认字体 SimSun、默认字号 1pt（只影响无 TextRun 的隐含段落）
            var stylesPart = main.AddNewPart<StyleDefinitionsPart>();
            stylesPart.Styles = new Styles(
                new DocDefaults(
                    new RunPropertiesDefault(
                        new RunPropertiesBaseStyle(
                            new RunFonts { Ascii = "SimSun", HighAnsi = "SimSun", EastAsia = "SimSun" },
                            new FontSize { Val = "2" })),
                    new ParagraphPropertiesDefault()));
            stylesPart.Styles.Save();

            main.Document.Save();
        }
        return ms.ToArray();
    }
}
