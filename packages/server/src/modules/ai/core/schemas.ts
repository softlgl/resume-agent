// 分析链路的 LLM 输出 JSON Schema（强制结构化输出）
// 注意：schema 保持扁平，仅在 provider 支持 json_schema 时生效；
// DeepSeek 只有 json_object 模式，复杂 schema 会被忽略。

// 期望 LLM 返回的 JSON Schema（用于强制结构化输出）
export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    atsScore: { type: "integer", minimum: 0, maximum: 100 },
    qualityScore: { type: "integer", minimum: 0, maximum: 100 },
    sections: {
      type: "object",
      properties: {
        basic: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string", enum: ["error", "warning", "tip"] },
              field: { type: "string" },
              problem: { type: "string" },
              suggestion: { type: "string" },
              rewrite: { type: "string" },
            },
            required: ["severity", "field", "problem"],
            additionalProperties: false,
          },
        },
        works: { type: "array" },
        projects: { type: "array" },
        skills: { type: "array" },
      },
      required: ["basic", "works", "projects", "skills"],
      additionalProperties: false,
    },
    abilityProfile: {
      type: "object",
      properties: {
        tech: { type: "integer", minimum: 0, maximum: 100 },
        project: { type: "integer", minimum: 0, maximum: 100 },
        stability: { type: "integer", minimum: 0, maximum: 100 },
        communication: { type: "integer", minimum: 0, maximum: 100 },
        education: { type: "integer", minimum: 0, maximum: 100 },
      },
      required: ["tech", "project", "stability", "communication", "education"],
      additionalProperties: false,
    },
    summary: {
      type: "object",
      properties: {
        overall: { type: "string" },
        strengths: { type: "array", items: { type: "string" } },
        weaknesses: { type: "array", items: { type: "string" } },
        priority: { type: "string" },
      },
      required: ["overall", "strengths", "weaknesses", "priority"],
      additionalProperties: false,
    },
  },
  required: ["atsScore", "qualityScore", "sections", "abilityProfile"],
  additionalProperties: false,
} as const;

export const MATCH_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    mustHaves: {
      type: "array",
      items: {
        type: "object",
        properties: {
          skill: { type: "string" },
          matched: { type: "boolean" },
        },
        required: ["skill", "matched"],
        additionalProperties: false,
      },
    },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["score", "mustHaves", "gaps"],
  additionalProperties: false,
} as const;