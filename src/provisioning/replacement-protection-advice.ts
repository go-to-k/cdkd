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
 * registers no `--remove-protection` Option at all (`deployOptions` in
 * `src/cli/options.ts`, fenced by
 * `tests/unit/cli/replacement-remedy-cli-facts.test.ts` against the real
 * Commander tree). So AWS refuses the delete and the command cdkd just told the
 * user to run dies on a SECOND wall with nothing named to do about it.
 *
 * Issue [#2610](https://github.com/go-to-k/cdkd/issues/2610) swept that shape
 * across the tree and found the same dead end on five more providers. This
 * module is the shared definition those five sites use, so the mechanism is
 * stated once rather than paraphrased five times — the reason
 * `lock-contention-message.ts` exists one directory over, and the reason
 * `display-safe.ts`'s header gives for not widening a rule by hand.
 *
 * `docs/cli-deploy-safety.md`'s "Deletion protection blocks a replacement"
 * section names all six types whose refusal says this explicitly (issue
 * [#2658](https://github.com/go-to-k/cdkd/issues/2658)), including the two
 * exceptions worth knowing before adding a seventh: ASG's arm is narrower than
 * its protection setting, and Cognito's fires after the desired bag is applied.
 *
 * `logs-loggroup-provider.ts` does NOT route through it and keeps its own text:
 * three review rounds on #2579 shaped clauses that are true only of that type
 * (`--force-stateful-recreation` has no per-resource granularity;
 * `LogGroupName` is the type's only replacement property, so a same-name
 * `Retain` replacement cannot complete at all), and a `suffix` parameter wide
 * enough to carry them would make the shared part the smaller half. Its message
 * is pinned by its own tests; this one by
 * `tests/unit/provisioning/replacement-remedy-preconditions.test.ts`.
 *
 * **Read that as a decision about the TEXT, never about the id rendering.**
 * That site hand-quotes its `physicalId` and does NOT get
 * {@link renderDisableCommand}'s sanitize / quote / suppress -- issue
 * [#2669](https://github.com/go-to-k/cdkd/issues/2669), deferred because
 * `tests/integration/loggroup-class-guard/verify.sh` REBUILDS the exact command
 * string to grep for it, so changing the rendering without re-running that
 * fixture leaves it green and blind.
 *
 * Two properties every caller owes, because only the caller can answer them:
 *
 * - **`evidence` must name the BAG it read.** Most read the RECORDED bag
 *   (`previousProperties`), which on the deploy path is
 *   `ResourceState.properties` — cdkd's best account of what AWS holds on the
 *   resource that is about to be deleted. A caller whose refusal fires AFTER
 *   the desired bag has been applied (`CognitoUserPoolProvider`'s schema guard
 *   runs after `UpdateUserPool`) must read the desired value first and say so.
 *   Protection enabled OUT OF BAND is in no bag at all, so such a resource
 *   still gets the short advice and still hits the wall — cdkd cannot see what
 *   it never recorded, and probing AWS from a refusal path would add a call to
 *   the failure route. Interpolate no unsanitized value into it: it is rendered
 *   to a terminal and captured into `deployments/*.jsonl`.
 * - **`disable.command` must change nothing but the flag.** Where a service's
 *   update API may take other members down with the flag, say so through
 *   `disable.caveat` — rendered OUTSIDE the backticks, so the pasteable span
 *   stays pasteable.
 *
 *   **State only what has been measured, per field.** This text used to assert
 *   that Cognito's `UpdateUserPool` "resets every member it is not sent" —
 *   AWS's own blanket wording, which `cognito-provider.ts`'s
 *   `readLiveMfaConfiguration` ledger shows holds FIELD BY FIELD and is FALSE
 *   for at least two (`MfaConfiguration` and both `Policies` sub-keys survive
 *   omission; `AutoVerifiedAttributes` does not). Issue
 *   [#2610](https://github.com/go-to-k/cdkd/issues/2610)'s review retired that
 *   universal from the user-facing caveat, and it survived HERE for a round —
 *   which is the failure mode worth naming, because this is the normative text
 *   a future caller copies. A blanket "resets to default" claim is per-field
 *   and needs a per-field measurement; `DeletionProtection`'s is issue
 *   [#2675](https://github.com/go-to-k/cdkd/issues/2675).
 */

import { displaySafe } from '../utils/display-safe.js';
import { shellQuote } from '../state/lock-contention-message.js';

/**
 * The doc section every caller points at. A single constant so a rename of the
 * heading cannot leave five providers pointing at a section that no longer
 * exists; `tests/unit/provisioning/replacement-remedy-preconditions.test.ts`
 * resolves it against `docs/cli-deploy-safety.md`'s actual headings.
 */
export const DELETION_PROTECTION_DOC_POINTER =
  '"Deletion protection blocks a replacement, and deploy cannot clear it" in docs/cli-deploy-safety.md';

/** What the message says when the resource id cannot be named on a command line. */
export const UNNAMEABLE_ID_CLAUSE =
  'Then disable protection out of band, via the console: the physical id cdkd recorded for this ' +
  'resource cannot be reproduced safely on a command line, so any command shown here would act on ' +
  'a different resource.';

/**
 * A string the COMPILER can prove is a literal.
 *
 * Two shapes are rejected, and the second is the one a plain
 * `string extends T` test misses:
 *
 *  - a WIDENED `string` -- what every non-literal expression produces:
 *    `'lit ' + String(x)`, a `const` declared `: string`, a value read out of a
 *    builder's return type, a spread of any of those, and (deliberately) a
 *    concatenation of two literals;
 *  - a TEMPLATE LITERAL TYPE carrying an interpolation. `` `aws x ${derived}` ``
 *    does NOT widen to `string` -- its type is `` `aws x ${string}` ``, so
 *    `string extends T` is FALSE and a one-line constraint accepts it, while
 *    the interpolated span is exactly the attacker-controlled text this module
 *    exists to keep out of a pasteable command. `HasInterpolation` walks the
 *    type one character at a time and reports any tail that IS `string`, which
 *    is what a `${...}` hole leaves behind. Measured on the longest literal in
 *    use (203 characters): no depth error, whole-project typecheck unchanged.
 *
 * Both resolve to `never` and fail to assign, at `vp run typecheck`.
 *
 * **Why a TYPE and not a test.** This constraint replaced a source-text sniff
 * over `src/` that was three spellings deep by the time issue [#2610]'s fifth
 * review round reached it: the first cut tested only a value's opening
 * character; the second joined continuation lines only until the value first
 * looked literal, so Prettier's operator-at-line-start layout walked through;
 * the third derived its population from field names near an `identifier`, which
 * a builder returning `{ before, after }` from another module simply exits.
 * Each hole was closed and the next one was found by the next probe. A grep
 * cannot see a type, so the honest fix is to stop grepping: a widened `string`
 * is now a COMPILE ERROR, which no refactor, spread, shorthand or far-away
 * `const` can walk out of. `tests/unit/cli/replacement-remedy-cli-facts.test.ts`
 * pins one `@ts-expect-error` per evasion shape instead.
 *
 * The one shape it also rejects is a concatenation of two LITERALS
 * (`'a' + 'b'` widens to `string` in TypeScript). That is a real cost, paid
 * deliberately: a single literal is what the fence can see, and the one caller
 * that concatenated was rewritten to use one.
 */
type HasInterpolation<T extends string> = string extends T
  ? true
  : T extends `${infer _Head}${infer Rest}`
    ? string extends Rest
      ? true
      : HasInterpolation<Rest>
    : false;

export type CdkdAuthoredLiteral<T extends string> = HasInterpolation<T> extends true ? never : T;

/**
 * The out-of-band disable command, split so only the IDENTIFIER is untrusted.
 *
 * `before` / `after` / `caveat` are rendered VERBATIM (inside the backticks for
 * the first two, beside them for the third), so they must be cdkd-authored
 * literals — the compiler now enforces that. `identifier` is the opposite: it
 * is a `state.json` value, and {@link protectedReplacementAdvice} sanitizes,
 * shell-quotes and suppresses it.
 */
export interface ProtectedReplacementDisableCommand<
  Before extends string = string,
  After extends string = string,
  Caveat extends string = string,
> {
  /**
   * Everything before the resource id, e.g.
   * `aws elbv2 modify-load-balancer-attributes --load-balancer-arn`.
   */
  before: CdkdAuthoredLiteral<Before>;
  /**
   * The resource's physical id. SANITIZED and SHELL-QUOTED here, and the whole
   * command is SUPPRESSED when sanitizing changes it — see
   * {@link protectedReplacementAdvice}.
   */
  identifier: string;
  /**
   * Everything after the id, e.g.
   * `--attributes Key=deletion_protection.enabled,Value=false`.
   */
  after?: CdkdAuthoredLiteral<After>;
  /**
   * Rendered as a sentence AFTER the command, never inside its backticks — it
   * reaches the terminal and the persisted events store like everything else
   * here.
   */
  caveat?: CdkdAuthoredLiteral<Caveat>;
}

/** The same shape with the literal constraint discharged, for internal use. */
interface ResolvedDisableCommand {
  before: string;
  identifier: string;
  after?: string;
  caveat?: string;
}

export interface ProtectedReplacementAdviceArgs<
  Before extends string = string,
  After extends string = string,
  Caveat extends string = string,
> {
  /**
   * A complete clause naming WHAT cdkd read and WHERE, with no trailing
   * punctuation — e.g. `"cdkd's recorded properties for this cluster carry
   * Instances.TerminationProtected: true"`. It is the first half of the
   * returned sentence, so it must read as a subject + verb.
   */
  evidence: string;
  /**
   * The flags the SHORT advice at this site names, spelled exactly as the user
   * would type them (e.g. `'cdkd deploy --replace --force-stateful-recreation'`).
   * Named twice in the output — once in the refusal and once in the re-run — so
   * the two can never drift.
   */
  replaceFlags: string;
  /** A concrete out-of-band way to turn protection off. */
  disable: ProtectedReplacementDisableCommand<Before, After, Caveat>;
}

/**
 * Render `disable` as a pasteable command, or `''` when its id cannot be named.
 *
 * The id reaching here is NOT an AWS-minted literal, which an earlier revision
 * of this module claimed and the review of issue [#2610] disproved: the deploy
 * engine passes `currentResource.physicalId` straight off `state.json`, and for
 * `AWS::DynamoDB::GlobalTable` and `AWS::AutoScaling::AutoScalingGroup` the
 * physical id is the TEMPLATE-chosen name. So it is exactly the class
 * `lock-contention-message.ts` handles, and it gets the identical treatment
 * rather than a second spelling of it:
 *
 *  - sanitize FIRST (`asciiOnly`, a positive allowlist — a control character
 *    has no legitimate place in an AWS physical id, and left in it forges lines
 *    on the operator's terminal and inside `deployments/*.jsonl`);
 *  - then `shellQuote`, the SAME predicate the force-unlock hint uses, so a
 *    value carrying a quote or a space cannot truncate when pasted;
 *  - and SUPPRESS the whole command when sanitizing CHANGED the value, because
 *    a command naming the sanitized id would act on a DIFFERENT resource — the
 *    wrong-target harm that module exists to prevent, and the reason emitting
 *    no command is the honest answer rather than a fallback.
 */
function renderDisableCommand(disable: ResolvedDisableCommand): string {
  const safeId = displaySafe(disable.identifier, { asciiOnly: true });
  if (!safeId || safeId !== disable.identifier) return '';
  const tail = disable.after ? ` ${disable.after}` : '';
  return `${disable.before} ${shellQuote(safeId)}${tail}`;
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
export function protectedReplacementAdvice<
  Before extends string,
  After extends string = string,
  Caveat extends string = string,
>(args: ProtectedReplacementAdviceArgs<Before, After, Caveat>): string {
  const { evidence, replaceFlags } = args;
  // The literal constraint has done its work at the call site; inside, these
  // are ordinary strings.
  const disable = args.disable as ResolvedDisableCommand;
  const command = renderDisableCommand(disable);
  const head =
    `${evidence}, so ${replaceFlags} alone will NOT succeed while AWS still has protection on: ` +
    `the replacement DELETES the resource, AWS refuses that delete while protection is on, and ` +
    `cdkd deploy has no --remove-protection flag to clear it (only cdkd destroy and ` +
    `cdkd state destroy act on one). Read ${DELETION_PROTECTION_DOC_POINTER} BEFORE you disable ` +
    `anything: whether disabling helps at all, and what the flag ends up as, depend on your ` +
    `UpdateReplacePolicy and on whether the deploy completes — neither of which this refusal can ` +
    `see.`;
  if (!command) return `${head} ${UNNAMEABLE_ID_CLAUSE} Then re-run with ${replaceFlags}.`;
  const caveat = disable.caveat ? ` ${disable.caveat}` : '';
  return (
    `${head} Then disable protection out of band — \`${command}\`, or via the console.${caveat} ` +
    `Then re-run with ${replaceFlags}.`
  );
}
