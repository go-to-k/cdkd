/**
 * `--pin-cc-api` reachability across the stacks of one deploy (issue
 * [#2719](https://github.com/go-to-k/cdkd/issues/2719)).
 *
 * The flag DECLINES a routing change and prints nothing when it works, so
 * every way it can quietly not apply is a way the user gets exactly the flip
 * they passed it to prevent. Two shapes, and they are not the same problem:
 *
 * - **Unmatched everywhere** — the id is in no stack of the run. Nothing can
 *   have been pinned, so this is an error, raised before any stack deploys.
 * - **Matched partially** — normal under `--all`, where an id belonging to one
 *   stack is legitimately absent from the others. Worth stating once, never an
 *   error, and never once PER non-matching stack: a single pinned id in a
 *   twenty-stack app would emit nineteen lines for a run in which nothing is
 *   wrong.
 *
 * A pure function, deliberately. This logic previously lived inline in
 * `deployCommand` and had no test; a review round moved it between log levels
 * and nothing would have caught it moving back.
 */
export interface PinCcApiStack {
  stackName: string;
  logicalIds: readonly string[];
}

export interface PinCcApiPartialMatch {
  logicalId: string;
  /** Stacks that declare it — non-empty by construction. */
  appliesTo: string[];
  /** Stacks that do not — non-empty by construction, else the match is total. */
  absentFrom: string[];
}

export interface PinCcApiReachability {
  /** Ids present in NO stack of the run. Non-empty means the deploy must fail. */
  unmatched: string[];
  /** Ids present in some stacks but not all. Informational only. */
  partial: PinCcApiPartialMatch[];
  /** Rendered error text for `unmatched`; empty when there is nothing to report. */
  errorMessage: string;
}

export function analyzePinCcApiReachability(
  pinnedLogicalIds: readonly string[],
  stacks: readonly PinCcApiStack[]
): PinCcApiReachability {
  const idSets = stacks.map((s) => ({ stackName: s.stackName, ids: new Set(s.logicalIds) }));
  const unmatched: string[] = [];
  const partial: PinCcApiPartialMatch[] = [];

  // De-duplicated: `--pin-cc-api X --pin-cc-api X` is a user typo, not two
  // findings, and reporting it twice makes the error read as two problems.
  for (const logicalId of [...new Set(pinnedLogicalIds)]) {
    const appliesTo = idSets.filter((t) => t.ids.has(logicalId)).map((t) => t.stackName);
    const absentFrom = idSets.filter((t) => !t.ids.has(logicalId)).map((t) => t.stackName);
    if (appliesTo.length === 0) {
      unmatched.push(logicalId);
    } else if (absentFrom.length > 0) {
      partial.push({ logicalId, appliesTo, absentFrom });
    }
  }

  const errorMessage =
    unmatched.length === 0
      ? ''
      : `--pin-cc-api named ${unmatched.length} logical id(s) present in no stack of this run:\n` +
        unmatched.map((id) => `  - ${id}`).join('\n') +
        `\n  Stacks in this run: ${idSets.map((t) => t.stackName).join(', ')}` +
        `\n  Fix: pass the CFn-emitted logical id, not the CDK display path ` +
        `(\`cdkd synth\`, then read \`.Resources | keys\`). A resource inside a NESTED child ` +
        `stack cannot be pinned from its parent's deploy — name it in a deploy of that child.`;

  return { unmatched, partial, errorMessage };
}
