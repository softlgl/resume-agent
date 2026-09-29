// 简历数据结构（packages/shared/src/resume.ts 的 C# 镜像）
// 序列化策略：System.Text.Json camelCase（与 TS 键名一致），缺失字段归一化为空串/空数组

using System.Text.Json.Serialization;

namespace ResumeAgent.Api.Contracts;

public class BasicInfo
{
    public string Name { get; set; } = "";
    public string Title { get; set; } = "";        // 求职意向 / 头衔
    public string Phone { get; set; } = "";
    public string Email { get; set; } = "";
    public string Location { get; set; } = "";
    public string Website { get; set; } = "";
    public string Summary { get; set; } = "";      // 个人简介
    public string Avatar { get; set; } = "";       // 头像 URL（可选）
    public string Birthday { get; set; } = "";     // 出生年月，格式 YYYY-MM
    public string Gender { get; set; } = "";
    public string CurrentStatus { get; set; } = ""; // 在职 / 离职 / 应届 等
    public string ExpectedSalary { get; set; } = "";
    public string WorkYears { get; set; } = "";
}

public class WorkExp
{
    public string Id { get; set; } = "";
    public string Company { get; set; } = "";
    public string Role { get; set; } = "";
    public string Start { get; set; } = "";
    public string End { get; set; } = "";
    public bool Current { get; set; }              // 至今
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string Description { get; set; } = "";  // 支持换行
}

public class EduExp
{
    public string Id { get; set; } = "";
    public string School { get; set; } = "";
    public string Major { get; set; } = "";
    public string Degree { get; set; } = "";
    public string Start { get; set; } = "";
    public string End { get; set; } = "";
    public string Description { get; set; } = "";
}

public class ProjectExp
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Company { get; set; } = "";      // 所属公司（可引用工作经历的公司，也可为空）
    public string Role { get; set; } = "";
    public string Start { get; set; } = "";
    public string End { get; set; } = "";
    public string Link { get; set; } = "";
    public string Description { get; set; } = "";
}

public class SkillGroup
{
    public string Id { get; set; } = "";
    public string Category { get; set; } = "";     // 分类，如 前端 / 后端 / 语言
    public string Items { get; set; } = "";        // 逗号或换行分隔的技能
}

public class ResumeContent
{
    public BasicInfo Basic { get; set; } = new();
    public List<WorkExp> Works { get; set; } = [];
    public List<EduExp> Educations { get; set; } = [];
    public List<ProjectExp> Projects { get; set; } = [];
    public List<SkillGroup> Skills { get; set; } = [];

    public static ResumeContent Empty() => new()
    {
        Basic = new BasicInfo(),
        Works = [],
        Educations = [],
        Projects = [],
        Skills = [],
    };

    /// <summary>反序列化后兜底：null → 空串/空数组，防止下游 NRE（对齐 TS 版非空语义）</summary>
    public ResumeContent Normalize()
    {
        Basic ??= new BasicInfo();
        Basic.Name ??= ""; Basic.Title ??= ""; Basic.Phone ??= ""; Basic.Email ??= "";
        Basic.Location ??= ""; Basic.Website ??= ""; Basic.Summary ??= ""; Basic.Avatar ??= "";
        Basic.Birthday ??= ""; Basic.Gender ??= ""; Basic.CurrentStatus ??= "";
        Basic.ExpectedSalary ??= ""; Basic.WorkYears ??= "";
        Works ??= []; Educations ??= []; Projects ??= []; Skills ??= [];
        foreach (var w in Works) { w.Id ??= ""; w.Company ??= ""; w.Role ??= ""; w.Start ??= ""; w.End ??= ""; w.Description ??= ""; }
        foreach (var e in Educations) { e.Id ??= ""; e.School ??= ""; e.Major ??= ""; e.Degree ??= ""; e.Start ??= ""; e.End ??= ""; e.Description ??= ""; }
        foreach (var p in Projects) { p.Id ??= ""; p.Name ??= ""; p.Company ??= ""; p.Role ??= ""; p.Start ??= ""; p.End ??= ""; p.Link ??= ""; p.Description ??= ""; }
        foreach (var s in Skills) { s.Id ??= ""; s.Category ??= ""; s.Items ??= ""; }
        return this;
    }
}

/// <summary>
/// 一次可应用的修改（AI 产出，经服务端 ResumeEditValidator.ValidateEdits 校验后的规范化形态）。
/// 字段顺序与 TS 版 ResumeEdit 一致，null 字段前端按 falsy 处理。
/// </summary>
public class ResumeEdit
{
    public string Op { get; set; } = "";                       // set | append
    public string Section { get; set; } = "";
    public string? Field { get; set; }                         // op=set 时必有，如 "works[0].description"
    public string Label { get; set; } = "";                    // 中文可读定位，如 "工作经历 · 第1条 · 描述"
    public string? Before { get; set; }                        // op=set：当前值（服务端从简历读出，非 AI 提供）
    public string? After { get; set; }                         // op=set：改写后内容
    public ResumeEditItem? Item { get; set; }                  // op=append：新条目骨架（事实字段已置空）
    public string? ItemId { get; set; }                        // op=append：服务端预生成的条目 id
    public string? Reason { get; set; }                        // 为什么这么改
    public List<string>? Risks { get; set; }                   // 风险提示
}

/// <summary>
/// op=append 的新条目骨架（对应 shared 里 Record&lt;string, string | boolean&gt;）。
/// 只为该 section 的合法字段赋值，未赋值的字段不输出——序列化形状与改造前的字典完全一致。
/// </summary>
public sealed class ResumeEditItem
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Company { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Role { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Name { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? School { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Major { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Degree { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Start { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? End { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Link { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Category { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Items { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? Description { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? Current { get; set; } // works 专用：至今

    /// <summary>是否有任何实际内容（用于「新增条目不能为空」判定；内部判定用，不进响应 JSON）</summary>
    [JsonIgnore]
    public bool HasContent =>
        Current == true ||
        new[] { Company, Role, Name, School, Major, Degree, Start, End, Link, Category, Items, Description }
            .Any(v => !string.IsNullOrEmpty(v));

    /// <summary>按 payload 字段名取值（表驱动的必填/事实校验用，字段名与前端契约一致）</summary>
    public string GetField(string name) => name switch
    {
        "company" => Company ?? "",
        "role" => Role ?? "",
        "name" => Name ?? "",
        "school" => School ?? "",
        "major" => Major ?? "",
        "degree" => Degree ?? "",
        "start" => Start ?? "",
        "end" => End ?? "",
        "link" => Link ?? "",
        "category" => Category ?? "",
        "items" => Items ?? "",
        "description" => Description ?? "",
        _ => "",
    };

    /// <summary>按 payload 字段名赋值；未知字段名忽略（不会凭空造出该 section 之外的键）</summary>
    public void SetField(string name, string value)
    {
        switch (name)
        {
            case "company": Company = value; break;
            case "role": Role = value; break;
            case "name": Name = value; break;
            case "school": School = value; break;
            case "major": Major = value; break;
            case "degree": Degree = value; break;
            case "start": Start = value; break;
            case "end": End = value; break;
            case "link": Link = value; break;
            case "category": Category = value; break;
            case "items": Items = value; break;
            case "description": Description = value; break;
        }
    }
}
