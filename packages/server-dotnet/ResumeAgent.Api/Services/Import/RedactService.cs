// 敏感信息脱敏（对齐 services/redact.ts）：本地抽取 → 替换占位（不发给 LLM）→ AI 完成后回填真值

using System.Text.RegularExpressions;

namespace ResumeAgent.Api.Services.Import;

public class SensitiveFields
{
    public string Name { get; set; } = "";
    public string Phone { get; set; } = "";
    public string Email { get; set; } = "";
    public string Location { get; set; } = "";
    public bool LocationReliable { get; set; } // 是否来自明确的"地址/现居地"标签（否则启发式易误判，不采用）
}

public static class RedactService
{
    // 本地抽取敏感字段。规则优先"字段名：值"，其次按各自格式启发式匹配；抽不到留空（走回退，仍发给 AI）
    public static SensitiveFields ExtractSensitive(string text)
    {
        var res = new SensitiveFields();

        // 电话：手机 1[3-9]xxxxxxxxx 或座机/带分隔符
        var phone = Regex.Match(text, @"(?:1[3-9]\d{9})|(?:\d{3,4}[- ]?\d{7,8}(?:[- ]?\d{1,6})?)");
        if (phone.Success) res.Phone = phone.Value;

        // 邮箱
        var email = Regex.Match(text, @"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}");
        if (email.Success) res.Email = email.Value;

        // 姓名：优先 "姓名/姓：xxx" 标签；否则取第一行 2~4 位纯中文（非手机/邮箱/链接）
        var nameLabel = Regex.Match(text, @"(?:姓名|姓)[:：]\s*([\u4e00-\u9fa5·]{2,4})");
        if (nameLabel.Success)
        {
            res.Name = nameLabel.Groups[1].Value;
        }
        else
        {
            var first = text.Split(["\r\n", "\n"], StringSplitOptions.None)
                .Select(l => l.Trim())
                .FirstOrDefault(l => l.Length > 0
                    && Regex.IsMatch(l, @"^[\u4e00-\u9fa5·]{2,4}$")
                    && !Regex.IsMatch(l, @"^(?:1[3-9]\d{9}|[A-Za-z0-9._%+-]+@|\w+://)"));
            if (first is not null) res.Name = first;
        }

        // 地址：仅取明确的"地址/现居地/居住地/住址/家乡：xxx"标签。
        // 兜底启发式极易误抓公司/项目行且会覆盖 LLM 的正确推断，故不采用；无标签时交给 LLM 推断。
        var addrLabel = Regex.Match(text, @"(?:地址|现居|居住地|住址|家乡)[:：]\s*(.+)");
        if (addrLabel.Success)
        {
            res.Location = Regex.Split(addrLabel.Groups[1].Value.Trim(), @"[\r\n,，;；]")[0];
            res.LocationReliable = true;
        }

        return res;
    }

    // 把抽出的敏感值在文本中替换为占位，返回脱敏后的文本（仅替换真正命中的字段）
    public static string RedactText(string text, SensitiveFields found)
    {
        var values = new HashSet<string>();
        foreach (var v in new[] { found.Name, found.Phone, found.Email, found.Location })
        {
            var t = v.Trim();
            if (t.Length > 0) values.Add(t);
        }
        var output = text;
        foreach (var v in values) output = output.Replace(v, "[已隐藏]");
        return output;
    }

    // AI 返回 content 后，用本地真实值回填对应 basic 字段（address → location；未抽到的字段保持 AI 的结果）
    public static void RestoreSensitive(ResumeAgent.Api.Contracts.ResumeContent content, SensitiveFields found)
    {
        if (found.Name.Length > 0) content.Basic.Name = found.Name;
        if (found.Phone.Length > 0) content.Basic.Phone = found.Phone;
        if (found.Email.Length > 0) content.Basic.Email = found.Email;
        if (found.Location.Length > 0) content.Basic.Location = found.Location;
    }
}
