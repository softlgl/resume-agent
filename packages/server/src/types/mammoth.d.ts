// mammoth 没有官方类型，这里声明用到的最小接口
declare module "mammoth" {
  export function extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  export function convertToHtml(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>;
}