// 敏感信息脱敏：本地抽取 → 替换占位（不发给 LLM）→ AI 完成后用本地真实值回填
import type { ResumeContent } from "@resume-agent/shared";

export interface SensitiveFields {
  name: string;
  phone: string;
  email: string;
  location: string;
  locationReliable: boolean; // 该 location 是否来自明确的"地址/现居地"标签（否则启发式易误判，不采用）
}

// 本地抽取敏感字段。规则优先"字段名：值"，其次按各自格式启发式匹配；抽不到留空（走回退，仍发给 AI）
export function extractSensitive(text: string): SensitiveFields {
  const res: SensitiveFields = { name: "", phone: "", email: "", location: "", locationReliable: false };

  // 电话：手机 1[3-9]xxxxxxxxx 或座机/带分隔符
  const phone = text.match(/(?:1[3-9]\d{9})|(?:\d{3,4}[- ]?\d{7,8}(?:[- ]?\d{1,6})?)/);
  if (phone) res.phone = phone[0];

  // 邮箱
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email) res.email = email[0];

  // 姓名：优先 "姓名/姓：xxx" 标签；否则取第一行 2~4 位纯中文（非手机/邮箱/链接）
  const nameLabel = text.match(/(?:姓名|姓)[:：]\s*([\u4e00-\u9fa5·]{2,4})/);
  if (nameLabel) {
    res.name = nameLabel[1];
  } else {
    const first = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && /^[\u4e00-\u9fa5·]{2,4}$/.test(l) && !/^(?:1[3-9]\d{9}|[A-Za-z0-9._%+-]+@|\w+:\/\/)/.test(l));
    if (first) res.name = first;
  }

  // 地址：仅取明确的"地址/现居地/居住地/住址/家乡：xxx"标签。
  // 兜底启发式（任意行含 省/市/区/县 就取）极易误抓到公司/项目行，且会覆盖 LLM 的正确推断，
  // 故不再采用；无标签时交给 LLM 推断，这里不本地回填。
  const addrLabel = text.match(/(?:地址|现居|居住地|住址|家乡)[:：]\s*(.+)/);
  if (addrLabel) {
    res.location = addrLabel[1].trim().split(/[\r\n,，;；]/)[0];
    res.locationReliable = true;
  }

  return res;
}

// 把抽出的敏感值在文本中替换为占位，返回脱敏后的文本（仅替换真正命中的字段）
export function redactText(text: string, found: Partial<SensitiveFields>): string {
  const values = new Set<string>();
  (Object.keys(found) as (keyof SensitiveFields)[]).forEach((k) => {
    const v = (found[k] || "").trim();
    if (v) values.add(v);
  });
  let out = text;
  values.forEach((v) => {
    out = out.replaceAll(v, "[已隐藏]");
  });
  return out;
}

// AI 返回 content 后，用本地真实值回填对应 basic 字段（address → location；未抽到的字段保持 AI 的结果）
export function restoreSensitive(content: ResumeContent, found: Partial<SensitiveFields>) {
  if (found.name) content.basic.name = found.name;
  if (found.phone) content.basic.phone = found.phone;
  if (found.email) content.basic.email = found.email;
  if (found.location) content.basic.location = found.location;
}