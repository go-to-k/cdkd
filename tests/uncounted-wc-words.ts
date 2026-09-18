import { classifyWcTrim } from '../scripts/check-integ-wc-trim.js';

// Shared by the wc-trim fence and its growth guard, which run in separate
// files so the guard's timings are taken in a heap holding only its own cases.

/**
 * Each occurrence of the WORD `wc` (bare or as a path's last segment) that is
 * not the command word of a counted invocation, comment text, or text in a
 * data heredoc — even on a line that also holds a counted one: a `wc` reached
 * some way the classifier does not read — through a variable (`COUNTER=wc; ${COUNTER} -l`),
 * `eval`, an alias, or as an argument of `xargs` / `find -exec`. Returns the
 * 1-based lines those occurrences are on.
 */
export function uncountedWcWords(content: string): number[] {
  const c = classifyWcTrim(content);
  // Line lookup by binary search over precomputed line starts: O(n log n) in
  // the file, not quadratic, since a fork PR can add a long fixture.
  const lineStarts = [0];
  for (let k = 0; k < content.length; k++) if (content[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  // Earliest real comment start per line.
  const commentStart = new Map<number, number>();
  for (const h of c.commentOffsets) {
    const line = lineOf(h);
    if (!commentStart.has(line) || h < commentStart.get(line)!) commentStart.set(line, h);
  }
  // Ranges are disjoint, and matches arrive in increasing offset order, so a
  // pointer that only moves forward answers "inside a range?" in linear time.
  const sweep = (ranges: Array<[number, number]>) => {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    let k = 0;
    return (offset: number) => {
      while (k < sorted.length && sorted[k]![1] <= offset) k++;
      return k < sorted.length && sorted[k]![0] <= offset;
    };
  };
  // A counted invocation covers every letter of its WORD, so `"wc"`,
  // `$'wc'` and `/usr/bin/wc` all match by range, not by the word's first index.
  const inCounted = sweep(c.invocations.map((i): [number, number] => [i.offset, i.wordEnd]));
  const inDataBody = sweep(c.dataHeredocBodies);
  const out = new Set<number>();
  // Anchored on the letters themselves (no leading character class that can
  // backtrack across a long line); the boundary is checked by hand.
  for (const m of content.matchAll(/wc(?![A-Za-z0-9_-])/g)) {
    const offset = m.index;
    const before = content[offset - 1];
    // `/wc` ends a path; any other word character before it makes a longer word.
    if (before !== undefined && before !== '/' && /[A-Za-z0-9_.-]/.test(before)) continue;
    // Each sweep is monotone in the offset, so skipping a call is harmless.
    if (inCounted(offset) || inDataBody(offset)) continue;
    const line = lineOf(offset);
    const hash = commentStart.get(line);
    if (hash !== undefined && hash < offset) continue;
    out.add(line);
  }
  return [...out];
}
