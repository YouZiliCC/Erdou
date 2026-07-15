export type DiffLine = { kind: "ctx" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // ignore trailing newline
  return lines;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length, m = b.length;
  // LCS table
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const out: DiffLine[] = [];
  let i = 0, j = 0, oldNo = 1, newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "ctx", text: a[i]!, oldNo: oldNo++, newNo: newNo++ }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { out.push({ kind: "del", text: a[i]!, oldNo: oldNo++ }); i++; }
    else { out.push({ kind: "add", text: b[j]!, newNo: newNo++ }); j++; }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]!, oldNo: oldNo++ });
  while (j < m) out.push({ kind: "add", text: b[j++]!, newNo: newNo++ });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.kind === "add") added++; else if (l.kind === "del") removed++; }
  return { added, removed };
}
