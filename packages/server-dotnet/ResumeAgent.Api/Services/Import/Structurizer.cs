// LLM 结构化（对齐 services/structurize.ts）：把抽取到的纯文本归一化成 ResumeContent

using System.Text.Json.Nodes;
using ResumeAgent.Api.Common;
using ResumeAgent.Api.Contracts;
using ResumeAgent.Api.Services.Llm;

namespace ResumeAgent.Api.Services.Import;

public class Structurizer(ChatService chat, ProfileSnapshotService profiles)
{
    // 期望 LLM 输出 ResumeContent 结构（键名固定，语义归一化由 LLM 完成）
    private const string ExtractSchema = """
        {
          "type": "object",
          "properties": {
            "basic": { "type": "object", "properties": {
              "name": { "type": "string" }, "title": { "type": "string" }, "phone": { "type": "string" },
              "email": { "type": "string" }, "location": { "type": "string" }, "website": { "type": "string" },
              "summary": { "type": "string" }, "birthday": { "type": "string" }, "gender": { "type": "string" },
              "currentStatus": { "type": "string" }, "expectedSalary": { "type": "string" }, "workYears": { "type": "string" } },
              "required": ["name", "title", "phone", "email", "location", "website", "summary", "birthday", "gender", "currentStatus", "expectedSalary", "workYears"] },
            "works": { "type": "array", "items": { "type": "object", "properties": {
              "company": { "type": "string" }, "role": { "type": "string" }, "start": { "type": "string" },
              "end": { "type": "string" }, "current": { "type": "boolean" }, "description": { "type": "string" } },
              "required": ["company", "role", "start", "end", "current", "description"] } },
            "educations": { "type": "array", "items": { "type": "object", "properties": {
              "school": { "type": "string" }, "major": { "type": "string" }, "degree": { "type": "string" },
              "start": { "type": "string" }, "end": { "type": "string" }, "description": { "type": "string" } },
              "required": ["school", "major", "degree", "start", "end", "description"] } },
            "projects": { "type": "array", "items": { "type": "object", "properties": {
              "name": { "type": "string" }, "company": { "type": "string" }, "role": { "type": "string" },
              "start": { "type": "string" }, "end": { "type": "string" }, "link": { "type": "string" }, "description": { "type": "string" } },
              "required": ["name", "company", "role", "start", "end", "link", "description"] } },
            "skills": { "type": "array", "items": { "type": "object", "properties": {
              "category": { "type": "string" }, "items": { "type": "string" } },
              "required": ["category", "items"] } }
          },
          "required": ["basic", "works", "educations", "projects", "skills"]
        }
        """;

    private static string BuildSystemPrompt() => """
        你是一名简历数据提取助手。请从用户提供的简历原文中提取信息，**只用下面给定的键名**输出一个 JSON 对象，用于归一化到统一的简历数据结构。

        输出必须严格符合以下结构（字段缺失时填空字符串；数组缺省为空数组）：
        - basic: { name(姓名), title(求职意向/头衔), phone(手机号), email(邮箱), location(所在城市), website(个人主页,没有填空), summary(个人简介/自我评价), birthday(出生年月,格式YYYY-MM), gender(性别), currentStatus(当前状态:在职/离职等), expectedSalary(期望薪资), workYears(工作年限) }
        - works: 工作经历数组，每项 { company(公司/任职单位), role(职位/岗位), start(开始时间,如2020-07), end(结束时间,如2024-12,标注"至今/现在"时为空), current(布尔:是否至今), description(工作内容/成果,可含换行) }
        - educations: 教育经历数组，每项 { school(学校), major(专业), degree(学历/学位), start, end, description }
        - projects: 项目经历数组，每项 { name(项目名), company(所属公司:从工作经历的公司中推断;个人/开源或无公司时可填空), role(你的角色), start, end, link(项目链接,没有填空), description }
        - skills: 技能分组数组，每项 { category(技能分类,如"前端"), items(该分类下技能,用英文逗号或顿号连接成字符串) }

        规则：
        1. 只输出 JSON，不要任何解释、markdown 代码块或额外文字。
        2. 把原文里不同的说法归一化到上面固定键：例如"公司名称/任职单位/单位"→company；"职位/岗位/担任职务"→role；"起止时间"→start/end；"教育背景/学历/学校"→school；"专业技能→skills"。时间统一转成 YYYY-MM。
        3. 无法识别或原文缺失的字段填空字符串，不要编造。
        4. current 为 true 当且仅当原文标注了"至今/现在/在职中"。
        """;

    /// <summary>把纯文本归一化成 ResumeContent；无 LLM 或解析失败返回 null</summary>
    public async Task<ResumeContent?> StructurizeTextAsync(
        string text, Action<string>? onReasoning = null, Action<string>? onContent = null,
        CancellationToken ct = default)
    {
        if (!profiles.IsAvailable()) return null;
        // maxTokens 给足够大的上限，让真实卡点收敛到 profile.maxOutput（推理模型与正文共享预算，偏小易截断）
        var outText = await chat.ChatStreamAsync(
        [
            new("system", BuildSystemPrompt()),
            new("user", $"以下是简历原文，请提取：\n\n{text}"),
        ], new ChatOptionsEx { JsonSchema = ExtractSchema, Temperature = 0.1, MaxTokens = 262144 },
            onReasoning, onContent, ct: ct);
        if (string.IsNullOrEmpty(outText)) return null;
        var raw = JsonNode.Parse(outText) as JsonObject;
        if (raw is null) return null;
        return Normalize(raw);
    }

    private static ResumeContent Normalize(JsonObject raw)
    {
        string Str(JsonNode? v) => v is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : "";
        static List<JsonNode> Arr(JsonObject o, string key) =>
            o[key] is JsonArray a ? [.. a] : [];

        var basic = raw["basic"] as JsonObject ?? [];
        return new ResumeContent
        {
            Basic = new BasicInfo
            {
                Name = Str(basic["name"]),
                Title = Str(basic["title"]),
                Phone = Str(basic["phone"]),
                Email = Str(basic["email"]),
                Location = Str(basic["location"]),
                Website = Str(basic["website"]),
                Summary = Str(basic["summary"]),
                Avatar = "",
                Birthday = Str(basic["birthday"]),
                Gender = Str(basic["gender"]),
                CurrentStatus = Str(basic["currentStatus"]),
                ExpectedSalary = Str(basic["expectedSalary"]),
                WorkYears = Str(basic["workYears"]),
            },
            Works = Arr(raw, "works").OfType<JsonObject>().Select(w => new WorkExp
            {
                Id = Cuid.New(),
                Company = Str(w["company"]),
                Role = Str(w["role"]),
                Start = Str(w["start"]),
                End = Str(w["end"]),
                Current = w["current"] is JsonValue cv && cv.TryGetValue<bool>(out var c) && c,
                Description = Str(w["description"]),
            }).ToList(),
            Educations = Arr(raw, "educations").OfType<JsonObject>().Select(e => new EduExp
            {
                Id = Cuid.New(),
                School = Str(e["school"]),
                Major = Str(e["major"]),
                Degree = Str(e["degree"]),
                Start = Str(e["start"]),
                End = Str(e["end"]),
                Description = Str(e["description"]),
            }).ToList(),
            Projects = Arr(raw, "projects").OfType<JsonObject>().Select(p => new ProjectExp
            {
                Id = Cuid.New(),
                Name = Str(p["name"]),
                Company = Str(p["company"]),
                Role = Str(p["role"]),
                Start = Str(p["start"]),
                End = Str(p["end"]),
                Link = Str(p["link"]),
                Description = Str(p["description"]),
            }).ToList(),
            Skills = Arr(raw, "skills").OfType<JsonObject>().Select(s =>
            {
                var itemsNode = s["items"];
                var itemsStr = itemsNode switch
                {
                    JsonArray list => string.Join(", ", list.OfType<JsonValue>()
                        .Select(jv => jv.TryGetValue<string>(out var x) ? x : "").Where(x => x.Length > 0)),
                    _ => Str(itemsNode),
                };
                return new SkillGroup { Id = Cuid.New(), Category = Str(s["category"]), Items = itemsStr };
            }).ToList(),
        };
    }
}
