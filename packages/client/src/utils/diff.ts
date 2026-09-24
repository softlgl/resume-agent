// ---------------------------------------------------------------------------
// 词级 diff（零依赖）
// 用于 EditCard 展示 AI 改写前后的差异：删除红底删除线、新增绿底。
// 中文逐字切分，英文/数字按单词切分，标点与空白各自成 token。
// LCS 动态规划规模上限 400×400，超限退化为按行 diff，避免大段描述卡顿。
// ---------------------------------------------------------------------------

export interface DiffToken {
  type: "same" | "add" | "del";
  text: string;
}

// CJK 统一表意文字 + 扩展 A + 兼容表意 + 日文假名 + 韩文音节
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
// 可组成一个「词」的字符：拉丁字母、数字、下划线、编程符号
const WORD_RE = /[A-Za-z0-9_+#.\-]/;

const MAX_CELLS = 400 * 400;

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (CJK_RE.test(c)) {
      out.push(c);
      i++;
    } else if (WORD_RE.test(c)) {
      let j = i;
      while (j < s.length && WORD_RE.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
    } else {
      out.push(c);
      i++;
    }
  }
  return out;
}

function lcsDiff(a: string[], b: string[]): DiffToken[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * w;
    const next = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] =
        a[i] === b[j]
          ? dp[next + j + 1] + 1
          : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

function lineDiff(before: string, after: string): DiffToken[] {
  const tokens = lcsDiff(before.split("\n"), after.split("\n"));
  return tokens.map((t) => ({ type: t.type, text: t.text + "\n" }));
}

// 合并相邻同类 token，避免逐字 diff 产生大量碎块
function merge(tokens: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (last && last.type === t.type) last.text += t.text;
    else out.push({ type: t.type, text: t.text });
  }
  return out;
}

export function wordDiff(before: string, after: string): DiffToken[] {
  const a = before || "";
  const b = after || "";
  if (a === b) return a ? [{ type: "same", text: a }] : [];
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length * tb.length > MAX_CELLS) return merge(lineDiff(a, b));
  return merge(lcsDiff(ta, tb));
}