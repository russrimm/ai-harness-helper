/**
 * A small line-oriented diff, good enough for showing a user what a save is
 * about to change. Uses a classic LCS dynamic-programming table; config files
 * are small enough that its O(n*m) cost is not a concern.
 */

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/** Above this many line-pairs, the O(n*m) LCS table gets too slow; fall back to a coarse diff. */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'remove', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
  const line = (list: string[], index: number): string => list[index] ?? '';

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = lcs[i];
      if (!row) continue;
      row[j] =
        line(a, i) === line(b, j) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (line(a, i) === line(b, j)) {
      result.push({ kind: 'context', text: line(a, i) });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      result.push({ kind: 'remove', text: line(a, i) });
      i += 1;
    } else {
      result.push({ kind: 'add', text: line(b, j) });
      j += 1;
    }
  }
  while (i < n) {
    result.push({ kind: 'remove', text: line(a, i) });
    i += 1;
  }
  while (j < m) {
    result.push({ kind: 'add', text: line(b, j) });
    j += 1;
  }
  return result;
}
