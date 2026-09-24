// Prompt 与脱敏（对齐 modules/ai.ts：ANALYSIS_SCHEMA / MATCH_SCHEMA / buildSystemPrompt / sanitizeContent / buildUserPrompt）

using System.Text.Json.Nodes;
using ResumeAgent.Api.Contracts;

namespace ResumeAgent.Api.Services.Analysis;

public static class Prompts
{
    // 期望 LLM 返回的 JSON Schema（用于强制结构化输出）
    public const string AnalysisSchema = """
        {
          "type": "object",
          "properties": {
            "atsScore": { "type": "integer", "minimum": 0, "maximum": 100 },
            "qualityScore": { "type": "integer", "minimum": 0, "maximum": 100 },
            "sections": {
              "type": "object",
              "properties": {
                "basic": { "type": "array", "items": { "type": "object", "properties": {
                  "severity": { "type": "string", "enum": ["error", "warning", "tip"] },
                  "field": { "type": "string" },
                  "problem": { "type": "string" },
                  "suggestion": { "type": "string" },
                  "rewrite": { "type": "string" } },
                  "required": ["severity", "field", "problem"] } },
                "works": { "type": "array" },
                "projects": { "type": "array" },
                "skills": { "type": "array" }
              },
              "required": ["basic", "works", "projects", "skills"]
            },
            "abilityProfile": {
              "type": "object",
              "properties": {
                "tech": { "type": "integer", "minimum": 0, "maximum": 100 },
                "project": { "type": "integer", "minimum": 0, "maximum": 100 },
                "stability": { "type": "integer", "minimum": 0, "maximum": 100 },
                "communication": { "type": "integer", "minimum": 0, "maximum": 100 },
                "education": { "type": "integer", "minimum": 0, "maximum": 100 }
              },
              "required": ["tech", "project", "stability", "communication", "education"]
            },
            "summary": {
              "type": "object",
              "properties": {
                "overall": { "type": "string" },
                "strengths": { "type": "array", "items": { "type": "string" } },
                "weaknesses": { "type": "array", "items": { "type": "string" } },
                "priority": { "type": "string" }
              },
              "required": ["overall", "strengths", "weaknesses", "priority"]
            }
          },
          "required": ["atsScore", "qualityScore", "sections", "abilityProfile"]
        }
        """;

    public const string MatchSchema = """
        {
          "type": "object",
          "properties": {
            "score": { "type": "integer", "minimum": 0, "maximum": 100 },
            "mustHaves": { "type": "array", "items": { "type": "object", "properties": {
              "skill": { "type": "string" }, "matched": { "type": "boolean" } },
              "required": ["skill", "matched"] } },
            "gaps": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["score", "mustHaves", "gaps"]
        }
        """;

    public static string BuildSystemPrompt() => """
        你是一名专业的招聘经理和简历优化专家。请分析候选人的简历，从以下维度给出结构化的评估：

        1. **ATS 友好度（atsScore）**：机器筛选系统能否快速识别关键信息（关键词覆盖、格式规范、冗余内容）
        2. **内容质量（qualityScore）**：招聘方视角，经历描述是否具体、有量化成果、用 STAR 法则、无空话套话
        3. **分模块问题（sections）**：指出每个 section 存在的具体问题，按严重程度（error/warning/tip）标注。
        4. **能力画像（abilityProfile）**：从技术能力、项目复杂度、工作稳定性、沟通能力（从文案推断）、教育背景五个维度打分
        5. **结构化总结（summary）**：给出 100 字内总体评价（overall）、2-4 条核心优势（strengths）、2-4 条核心短板（weaknesses）、1 条最值得优先做的行动（priority）。总结要具体、有依据，避免空话。

        **rewrite 字段使用规则（非常重要）**：
        rewrite 是可选字段，只在"可以从现有内容推理出改写结果"时填写。分两种情况：

        ✅ **给 rewrite 的情况**（字段有内容，但质量差）：
        - 工作/项目描述太笼统 → rewrite 写改写后的完整描述（加量化、STAR 法则、关键词）
        - 技能描述太简单 → rewrite 写扩展后的版本
        - 自我总结太空 → rewrite 写更具体的总结
        → rewrite 必须是完整的替换文本，不是"建议添加 XX"

        ❌ **不给 rewrite 的情况**（AI 不可能知道真实值）：
        - 字段完全为空/缺失（如 works[0].end 结束时间、projects[0].link 项目链接、手机号缺失）
        - 需要候选人提供真实外部信息（薪资、邮箱、GitHub URL、具体日期）
        - 涉及主观判断（如"建议把项目移到最前面"——这是排序建议，不能用 rewrite 实现）
        → 只给 problem（问题描述）+ suggestion（操作建议），**不要填 rewrite**

        **field 定位规则（同样非常重要）**：
        - field 必须精确到某一个**字符串字段**，且路径里数组必须带下标，如 basic.summary、works[0].description、projects[2].description、skills[0].items。
        - **禁止把整段 section 名（works/projects/educations/skills/basic，不带下标）当作 field**，也禁止给这类整段字段配 rewrite。整段是数组/对象，前端无法用一段纯文本覆盖；能重写的是段内的具体字符串字段。
        - 若要改写某条经历的描述，field 必须是 works[0].description 这种带下标的路径，rewrite 才是那条描述的新文本。
        - 数组或对象本身的增删（如「新增一段经历」）应写成 problem + suggestion，不给 rewrite、也不把整段名当 field。

        评分标准：
        - 0-40 分：明显不足
        - 40-70 分：基本合格但有明显短板
        - 70-90 分：较好
        - 90-100 分：优秀

        field 字段要用 JSON 路径格式，精确到字符串字段且数组带下标，如 basic.summary、works[0].description、projects[1].description；不要输出不带下标的整段名（如 skills）。
        """;

    // 敏感字段脱敏：发送给 LLM 前替换为占位符，避免真实个人隐私外泄
    // 强制脱敏的键（联系方式/证件/地址/薪资/外链）在任何层级都脱敏；
    // name/realName 只"在 basic 节下"才当人名脱敏——projects[].name 是项目名、
    // works[].name 是公司名、educations[].name 是学校名，绝不能脱敏。
    private static readonly Dictionary<string, string> ForceKeys = new()
    {
        ["phone"] = "[手机号]", ["mobile"] = "[手机号]", ["tel"] = "[电话]", ["telephone"] = "[电话]",
        ["email"] = "[邮箱]", ["mail"] = "[邮箱]", ["qq"] = "[QQ]",
        ["wechat"] = "[微信]", ["wx"] = "[微信]", ["weixin"] = "[微信]",
        ["idcard"] = "[证件号]", ["idnumber"] = "[证件号]",
        ["avatar"] = "[头像]", ["photo"] = "[头像]",
        ["address"] = "[住址]", ["expectedsalary"] = "[期望薪资]", ["salary"] = "[薪资]",
        ["website"] = "[主页链接]", ["homepage"] = "[主页链接]",
        ["github"] = "[代码库链接]", ["gitee"] = "[代码库链接]", ["links"] = "[链接]", ["blog"] = "[博客链接]",
    };
    private static readonly Dictionary<string, string> BasicNameKeys = new() { ["name"] = "[姓名]", ["realname"] = "[姓名]" };

    public static JsonNode? SanitizeContent(JsonNode? value, bool inBasic = false)
    {
        if (value is null) return null;
        if (value is JsonArray arr)
        {
            var outArr = new JsonArray();
            foreach (var item in arr) outArr.Add(SanitizeContent(item, inBasic));
            return outArr;
        }
        if (value is JsonObject obj)
        {
            var outObj = new JsonObject();
            foreach (var (k, v) in obj)
            {
                var low = k.ToLowerInvariant();
                var childIsBasic = inBasic || low == "basic";
                if (v is JsonValue jv && jv.TryGetValue<string>(out var s) &&
                    (ForceKeys.TryGetValue(low, out var force) || (childIsBasic && BasicNameKeys.TryGetValue(low, out force))))
                {
                    outObj[k] = force;
                }
                else
                {
                    outObj[k] = SanitizeContent(v?.DeepClone(), childIsBasic);
                }
            }
            return outObj;
        }
        return value.DeepClone();
    }

    public static string BuildUserPrompt(JsonNode sanitizedContent, string? jd)
    {
        var text = $"""
            以下是候选人的简历（JSON 格式，敏感信息已脱敏）：
            ```json
            {sanitizedContent.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true })}
            ```
            """;
        if (!string.IsNullOrWhiteSpace(jd))
            text += $"""

                --- 目标岗位 JD ---

                {jd.Trim()}
                """;
        text += """

            请按 JSON Schema 格式输出分析结果。
            """;
        return text;
    }
}
