import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// 轻量 Markdown 渲染（零依赖）
// 支持：**粗体**、`行内代码`、``` 围栏代码 ```、-/* 无序列表、1. 有序列表、
//       ### 标题、空行分段。
// 解析结果直接生成 React 节点树（不使用 dangerouslySetInnerHTML），天然免疫 XSS。
// ---------------------------------------------------------------------------

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code
          key={`${keyPrefix}-c${k++}`}
          className="px-1 py-0.5 rounded bg-slate-100 text-[0.85em] font-mono text-slate-700"
        >
          {tok.slice(1, -1)}
        </code>
      );
    } else {
      out.push(
        <strong key={`${keyPrefix}-b${k++}`} className="font-semibold text-slate-900">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isFence = (l: string) => /^\s*```/.test(l);
const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
const isUl = (l: string) => /^\s*[-*]\s+/.test(l);
const isOl = (l: string) => /^\s*\d+\.\s+/.test(l);

export function MarkdownLite({ text }: { text: string }) {
  const lines = (text || "").split("\n");
  const nodes: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) buf.push(lines[i++]);
      i++; // 跳过闭合的 ```
      nodes.push(
        <pre
          key={key++}
          className="my-2 rounded-lg bg-slate-900 text-slate-100 text-xs px-3 py-2 overflow-x-auto"
        >
          <code>{buf.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (isHeading(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const content = line.replace(/^#{1,6}\s+/, "");
      nodes.push(
        <div
          key={key++}
          className={`font-semibold text-slate-800 mt-3 mb-1 ${
            level <= 2 ? "text-base" : "text-sm"
          }`}
        >
          {renderInline(content, `h${key}`)}
        </div>
      );
      i++;
      continue;
    }

    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={key++} className="list-disc pl-5 my-1 space-y-0.5">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ul${key}-${ii}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      nodes.push(
        <ol key={key++} className="list-decimal pl-5 my-1 space-y-0.5">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ol${key}-${ii}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落：连续的非特殊行合并为一个 <p>，行内换行原样保留
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isFence(lines[i]) &&
      !isHeading(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    nodes.push(
      <p key={key++} className="my-1 whitespace-pre-wrap">
        {renderInline(buf.join("\n"), `p${key}`)}
      </p>
    );
  }

  return <div className="text-sm leading-relaxed">{nodes}</div>;
}