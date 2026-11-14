export interface DiffLine {
  /** ' ' unchanged, '-' only in the current file, '+' only in the backup's file. */
  kind: ' ' | '-' | '+';
  text: string;
}

/** Inputs longer than this are not diffed (the LCS table grows with the product of both lengths). */
export const maxDiffLines = 2000;

function lines(text: string) {
  const split = text.replace(/\r\n/g, '\n').split('\n');
  if (split.at(-1) === '') split.pop();
  return split;
}

/** A line diff from `before` to `after` (longest common subsequence), or null if either is too long. */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const left = lines(before);
  const right = lines(after);
  if (left.length > maxDiffLines || right.length > maxDiffLines) return null;
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { result.push({ kind: ' ', text: left[i] }); i += 1; j += 1; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { result.push({ kind: '-', text: left[i] }); i += 1; }
    else { result.push({ kind: '+', text: right[j] }); j += 1; }
  }
  for (; i < left.length; i += 1) result.push({ kind: '-', text: left[i] });
  for (; j < right.length; j += 1) result.push({ kind: '+', text: right[j] });
  return result;
}
