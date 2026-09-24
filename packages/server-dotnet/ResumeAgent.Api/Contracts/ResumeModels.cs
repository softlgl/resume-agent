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
