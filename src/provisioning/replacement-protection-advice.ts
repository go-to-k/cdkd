/**
 * The sentence a provider's replacement advice must say instead of a bare
 * "re-deploy with `--replace`" when cdkd's own properties already say the
 * resource carries a deletion / termination protection flag.
 *
 * Issue [#2579](https://github.com/go-to-k/cdkd/issues/2579) established the
 * shape on `AWS::Logs::LogGroup`: the advised replacement runs its DELETE from
 * the deploy engine, which never sets `DeleteContext.removeProtection` — every
 * provider's flip-off is gated on that field and only the DESTROY paths
 * (`cdkd destroy`, `cdkd state destroy`) set it, because `cdkd deploy`
 * registers no `--remove-protection` Option at all
 * (`deployOptions` in `src/cli/options.ts`). So AWS refuses the delete and the
 * command cdkd just told the user to run dies on a SECOND wall with nothing
 * named to do about it.
 *
 * Issue [#2610](https://github.com/go-to-k/cdkd/issues/2610) swept that shape
 * across the tree and found the same dead end on five more providers. This
 * module exists so those sites share ONE definition of the mechanism rather
 * than six paraphrases of it — the same reason `lock-contention-message.ts`
 * exists one directory over, and the reason `display-safe.ts`'s header gives
 * for not widening a rule by hand one module at a time.
 *
 * **A LEAF module — no imports, ever.** Every caller is a provider under
 * `providers/`, several of which sit on the `register-providers.ts` import
 * ring; `nested-stack-messages.ts` records what closing that ring costs. There
 * is nothing here that needs an import.
 *
 * Two properties every caller owes, and neither is checked here because only
 * the caller can answer them:
 *
 * - **`evidence` must name the bag it read.** Most callers read the RECORDED
 *   bag (`previousProperties`), which on the deploy path is
 *   `ResourceState.properties` — cdkd's best account of what AWS holds on the
 *   resource that is about to be deleted. A caller whose refusal fires AFTER
 *   the desired bag has already been applied (`CognitoUserPoolProvider`'s
 *   schema guard runs after `UpdateUserPool`) must read the desired value
 *   first and say so. Protection enabled OUT OF BAND is in no bag at all, so
 *   such a resource still gets the short advice and still hits the wall —
 *   cdkd cannot see what it never recorded, and probing AWS from a refusal
 *   path would add a call to the failure route.
 * - **`disableCommand` must be a command that disables protection WITHOUT
 *   changing anything else.** Where the service exposes only a full-replace
 *   update (Cognito's `UpdateUserPool` resets every member it is not sent),
 *   say so in the string rather than shipping a one-liner that silently wipes
 *   the caller's configuration.
 *
 * The values interpolated into `disableCommand` are rendered raw, matching the
 * issue [#2579] site this generalizes. They are AWS-minted identifiers (an
 * ARN, a cluster id, a table name) rather than the operator-controlled strings
 * `lock-contention-message.ts` sanitizes and suppresses.
 */

/**
 * The doc section every caller points at. A single constant so a rename of the
 * heading cannot leave five providers pointing at a section that no longer
 * exists — and so the cross-reference test can find the pointer by name.
 */
export const DELETION_PROTECTION_DOC_POINTER =
  '"Deletion protection blocks a replacement, and deploy cannot clear it" in docs/cli-deploy-safety.md';

export interface ProtectedReplacementAdviceArgs {
  /**
   * A complete clause naming WHAT cdkd read and WHERE, with no trailing
   * punctuation — e.g. `"cdkd's recorded properties for this cluster carry
   * Instances.TerminationProtected: true"`. It is the first half of the
   * returned sentence, so it must read as a subject + verb.
   */
  evidence: string;
  /**
   * The flags the SHORT advice at this site names, spelled exactly as the user
   * would type them (e.g. `'--replace --force-stateful-recreation'`). Named
   * twice in the output — once in the refusal and once in the re-run — so the
   * two can never drift.
   */
  replaceFlags: string;
  /**
   * A concrete out-of-band way to turn protection off, rendered inside
   * backticks. See the module header for what makes one safe to name.
   */
  disableCommand: string;
}

/**
 * Build the "your advised replacement is blocked by a protection flag" advice.
 *
 * Deliberately STOPS at what a provider's `update()` can know. It sees neither
 * `UpdateReplacePolicy` nor what the replacement then does, and three review
 * rounds on issue [#2579] each proved a different sentence about that
 * downstream mechanism false — so the outcome of disabling is handed to the
 * doc, which has the policy in view. A shorter message that is TRUE beats a
 * complete one that is not.
 */
export function protectedReplacementAdvice(args: ProtectedReplacementAdviceArgs): string {
  const { evidence, replaceFlags, disableCommand } = args;
  return (
    `${evidence}, so ${replaceFlags} alone will NOT succeed while AWS still has protection on: ` +
    `the replacement DELETES the resource, AWS refuses that delete while protection is on, and ` +
    `cdkd deploy has no --remove-protection flag to clear it (only cdkd destroy and ` +
    `cdkd state destroy act on one). Read ${DELETION_PROTECTION_DOC_POINTER} BEFORE you disable ` +
    `anything: whether disabling helps at all, and what the flag ends up as, depend on your ` +
    `UpdateReplacePolicy and on whether the deploy completes — neither of which this refusal can ` +
    `see. Then disable protection out of band — \`${disableCommand}\`, or via the console — and ` +
    `re-run with ${replaceFlags}.`
  );
}
