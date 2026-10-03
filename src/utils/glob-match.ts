/**
 * Whether `subject` matches the glob `pattern`, where `*` matches any run of
 * characters (the empty run included) and EVERY other character is literal.
 *
 * One SEGMENT of a stack-selection pattern: {@link pathGlobMatches} applies it
 * per `/`-separated segment for `stackMatchesPattern`
 * (`src/cli/stack-matcher.ts`)
 * ([#3508](https://github.com/go-to-k/cdkd/issues/3508)). An import-free LEAF,
 * so any layer may import it.
 *
 * **Never a RegExp.** Its callers used to expand `*` into `.*` and compile the
 * result, which had two defects: a pattern with several `*` separated by
 * literals backtracked EXPONENTIALLY in the length of the subject (a stack
 * name or Stage path from the Cloud Assembly), and the other characters were
 * live regex syntax only when the pattern held a `*` — `My.Stage*` matched
 * `MyXStage1` while `My.Stage` matched only itself, and `My(Stage*` threw a
 * `SyntaxError`.
 *
 * The walk anchors the text before the first `*` at the start and the text
 * after the last `*` at the end, then places each middle segment at its
 * LEFTMOST occurrence after the previous one. Leftmost placement is optimal
 * when `*` is the only wildcard — any later placement leaves strictly less room
 * for the segments after it — so no backtracking is needed. The cost is one
 * `indexOf` per segment, O(|subject| x |pattern|) in the worst case:
 * polynomial, where the RegExp was exponential.
 */
export function globMatches(pattern: string, subject: string): boolean {
  const segments = pattern.split('*');
  if (segments.length === 1) return pattern === subject;

  const head = segments[0]!;
  const tail = segments[segments.length - 1]!;
  // The head and tail must not overlap: `a*a` needs at least two characters.
  if (subject.length < head.length + tail.length) return false;
  if (!subject.startsWith(head) || !subject.endsWith(tail)) return false;

  const end = subject.length - tail.length;
  let cursor = head.length;
  for (let i = 1; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (segment === '') continue;
    const at = subject.indexOf(segment, cursor);
    if (at === -1 || at + segment.length > end) return false;
    cursor = at + segment.length;
  }
  return true;
}

/**
 * Whether a `/`-separated `subject` matches the path glob `pattern`, as the
 * AWS CDK CLI matches a stack pattern against a stack's hierarchical id with
 * picomatch ([#4474](https://github.com/go-to-k/cdkd/issues/4474)):
 *
 * - `*` matches any run of characters WITHIN one segment and never crosses
 *   `/`, so `'*'` selects top-level stacks only and `'Stage/*'` the stacks
 *   directly inside `Stage`;
 * - a segment that is exactly `**` matches zero or more whole segments, so
 *   `'**'` selects every stack at any depth;
 * - every other character is literal, as in {@link globMatches}, which matches
 *   each segment. Unlike picomatch, `?`, `[...]`, `{a,b}` and a leading `!`
 *   have no meaning here;
 * - `*` and `**` also match a segment that starts with `.`, which picomatch's
 *   do not by default.
 *
 * **Never a RegExp**, for the reason {@link globMatches} gives. The segments
 * are matched by bottom-up dynamic programming over (pattern segment, subject
 * segment), so a run of `**` costs O(|pattern| x |subject|) segment matches
 * rather than an exponential backtrack, and no recursion depth.
 */
export function pathGlobMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('/');
  const s = subject.split('/');
  // can[j] = whether p[i..] matches s[j..], filled from the last pattern
  // segment back. Iterative, so a long run of `**` cannot exhaust the stack.
  let can: boolean[] = s.map(() => false).concat(true);
  for (let i = p.length - 1; i >= 0; i--) {
    const next: boolean[] = new Array<boolean>(s.length + 1).fill(false);
    if (p[i] === '**') {
      // Zero segments (can[j]), or one more and stay on the globstar.
      for (let j = s.length; j >= 0; j--) next[j] = can[j]! || (j < s.length && next[j + 1]!);
    } else {
      for (let j = 0; j < s.length; j++) next[j] = can[j + 1]! && globMatches(p[i]!, s[j]!);
    }
    can = next;
  }
  return can[0]!;
}
