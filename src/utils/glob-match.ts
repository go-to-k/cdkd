/**
 * Whether `subject` matches the glob `pattern`, where `*` matches any run of
 * characters (the empty run included) and EVERY other character is literal.
 *
 * The one answer to "what does a stack-selection pattern mean", shared by
 * `stackMatchesPattern` (`src/cli/stack-matcher.ts`) and the failed-Stage
 * attribution in `src/synthesis/failed-stages.ts`, so the two cannot disagree
 * ([#3508](https://github.com/go-to-k/cdkd/issues/3508)). An import-free LEAF,
 * so both layers may import it.
 *
 * **Never a RegExp.** Both sites used to expand `*` into `.*` and compile the
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
