import {
  cdkdRemedy,
  type PasteableCommand,
  pasteableCommand,
  withheldTargetClause,
} from '../../../utils/pasteable-command.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { CdkdError } from '../../../utils/error-handler.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayStackName } from '../../../utils/display-safe.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
// Issue #2133 review: the SAME edge inference `cdkd deploy` orders with, so
// scrub's `--all` order is producer-before-consumer for a RAW
// `cdk.Fn.importValue` too — CDK emits no manifest dependency for one.
import { inferCrossStackStackDeps } from '../../../analyzer/cross-stack-deps.js';
import { producerRecordKey } from '../../../state/malformed-resources-bag.js';
import { ScrubRefusalError } from './errors.js';
import type { SecretExpressionVerdict } from './producer-expression.js';
import { maskedIdent, proseName, proseWithholds, proseStackName } from './abandoned-scan.js';

/**
 * Order scrub targets PRODUCER-BEFORE-CONSUMER (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133) review).
 *
 * `cdkd scrub --all` used to walk the assembly's artifact order, which is not
 * topological — `getAllStacks` iterates the manifest, and only `cdkd deploy`
 * sorts. That ordering decides whether a legacy multi-stack app can be scrubbed
 * in ONE run: a consumer importing a secret learns its expression only by
 * reading the producer's state, and that state holds the expression only once
 * the PRODUCER has been scrubbed. Reached in the other order the consumer gets
 * a plaintext, has no needle, and is refused
 * ({@link plaintextProducerCrossStackReadError}) until the user re-runs. Both
 * orders are SAFE — the refusal is what makes them safe — but only one of them
 * finishes the job in a single command.
 *
 * Edges come from BOTH sources `cdkd deploy` uses: CDK's own manifest
 * dependencies (`dependencyNames`, emitted for a strong reference through
 * `exportValue`) and {@link inferCrossStackStackDeps}, which scans the
 * synthesized templates for a RAW `cdk.Fn.importValue` / `Fn::GetStackOutput`
 * that CDK records no dependency for. Edges to stacks outside the target set
 * are ignored: a producer that is not being scrubbed cannot be ordered.
 *
 * Cycles cannot happen through `Fn::ImportValue` on a deployable app, but a
 * cycle in the INFERRED graph is possible (two stacks reading each other's
 * outputs weakly), so the sort degrades to input order for whatever it cannot
 * place rather than dropping or duplicating a stack. Ties keep input order, so
 * a single-stack or dependency-free `--all` run is byte-identical to before.
 */
export function orderScrubTargets<
  T extends {
    stackName: string;
    /**
     * Optional HERE though `StackInfo` types it as required: the assembly
     * reader always supplies it, but a caller assembling a stack record by
     * hand may not, and an ordering helper must not be the thing that throws.
     */
    dependencyNames?: string[] | undefined;
    template: CloudFormationTemplate;
  },
>(targets: readonly T[]): T[] {
  if (targets.length < 2) return [...targets];
  const inSet = new Set(targets.map((t) => t.stackName));
  const inferred = inferCrossStackStackDeps(targets);
  const producersOf = new Map<string, Set<string>>();
  for (const target of targets) {
    const producers = new Set<string>();
    for (const dep of target.dependencyNames ?? []) {
      if (inSet.has(dep) && dep !== target.stackName) producers.add(dep);
    }
    for (const dep of inferred.get(target.stackName) ?? []) {
      if (inSet.has(dep) && dep !== target.stackName) producers.add(dep);
    }
    producersOf.set(target.stackName, producers);
  }
  const ordered: T[] = [];
  const emitted = new Set<string>();
  const pending = [...targets];
  while (pending.length > 0) {
    // First stack, IN INPUT ORDER, whose producers are all already emitted.
    let index = pending.findIndex((t) =>
      [...(producersOf.get(t.stackName) ?? [])].every((p) => emitted.has(p))
    );
    // A cycle in the inferred graph: nothing is ready, so take the head and
    // keep going rather than looping forever or losing a stack.
    if (index === -1) index = 0;
    const [next] = pending.splice(index, 1);
    if (!next) break;
    ordered.push(next);
    emitted.add(next.stackName);
  }
  return ordered;
}

/**
 * Exported for its unit fence alone — no second production caller. The
 * collision it must not have (go-to-k/cdkd#3323) is only observable from
 * whether two queries SHARE a promise, which driving a whole `scrubStack`
 * fixture cannot show without asserting on a much larger outcome.
 */
export function memoizeCrossStackStateReads(backend: S3StateBackend): S3StateBackend {
  const view = Object.create(backend) as S3StateBackend;
  let listed: ReturnType<S3StateBackend['listStacks']> | undefined;
  const states = new Map<string, ReturnType<S3StateBackend['getState']>>();
  view.listStacks = (): ReturnType<S3StateBackend['listStacks']> => {
    listed ??= backend.listStacks();
    return listed;
  };
  view.getState = (
    stackName: string,
    stateRegion: string
  ): ReturnType<S3StateBackend['getState']> => {
    // {@link producerRecordKey} for why it ENCODES rather than separates. A
    // collision here changes an ANSWER rather than dropping a warning line: a
    // shared promise serves record X's state to a query about record Y, and
    // scrub's cross-stack pre-pass reads exactly that to decide whether a
    // producer still holds plaintext (go-to-k/cdkd#3323).
    //
    // A "this site was fail-CLOSED anyway" argument was written here for one
    // round and is WRONG; it is recorded so nobody re-derives it. It ran: a
    // colliding pair must carry a NUL in some half, that half goes into an S3
    // key, S3 will not serve one, so both reads fail. The last step is false:
    // `tryGetLegacy` keys on the STACK NAME alone and the region never enters
    // the key. Its region gate does not stop it either — `readLegacyRegion`
    // and `tryGetLegacy` read the SAME body, so the gate compares that body's
    // region against a value taken from it and matches by construction. So a
    // NUL-bearing REGION reads successfully through the legacy key and its
    // promise is served to the colliding query. Do not settle this site, or
    // any other, by asking what S3 will store.
    const key = producerRecordKey(stackName, stateRegion);
    let pending = states.get(key);
    if (!pending) {
      pending = backend.getState(stackName, stateRegion);
      states.set(key, pending);
    }
    return pending;
  };
  return view;
}

/**
 * Is this template output one the deploy would NOT have written (issue #2133
 * review)?
 *
 * The outputs passes deliberately run over EVERY declared output regardless of
 * its `Condition`, so a secret carried by a (possibly spuriously) suppressed
 * output still becomes a needle for the resource records that share it. That
 * argument justifies RESOLVING a suppressed output, and nothing more — it does
 * not justify REFUSING the whole stack when such a resolution fails, because a
 * suppressed output produced no `state.outputs` key and so has nothing at risk.
 * A dev-environment scrub would otherwise be refused outright by a prod-only
 * `Value: {Fn::ImportValue: ProdOnlyExport}` whose producer does not exist in
 * dev. So: resolve it best-effort, but disarm the refusal.
 *
 * An UNKNOWN condition counts as suppressed, matching `resolveIf`'s
 * unknown-selects-FALSE rule and erring toward not refusing.
 *
 * STATE OVERRULES THE CONDITION (issue #2133 review). `conditions` degrades to
 * `{}` whenever `evaluateConditions` throws, and even when it succeeds it is
 * evaluated from TEMPLATE PARAMETER DEFAULTS — scrub takes no `--parameters` —
 * so an output the deploy really did write reads as suppressed on any stack
 * deployed with non-default parameters, which silently disarms the refusal for
 * that position. `state.outputs` is the record of what the deploy ACTUALLY
 * wrote (keyed by output NAME, plus the export-name alias), so a key present
 * there is proof the output was not suppressed, whatever this run's
 * best-effort condition evaluation concluded.
 */
export function isOutputSuppressed(
  name: string,
  output: { Condition?: unknown },
  conditions: Record<string, boolean>,
  stateOutputs: Record<string, unknown>
): boolean {
  const condition = output.Condition;
  if (typeof condition !== 'string') return false;
  if (conditions[condition] === true) return false;
  // `Object.hasOwn`, not `in` (issue #3515): an Output legally named
  // `constructor` / `toString` answered `in` through the prototype chain, so a
  // suppressed one read as WRITTEN and re-armed the refusal it exists to disarm.
  return !Object.hasOwn(stateOutputs, name);
}

/**
 * The intrinsics that read ANOTHER stack's state (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)).
 *
 * Both require `context.stateBackend` — `resolveImportValue` throws without it,
 * and `Fn::GetStackOutput` reaches the same requirement through
 * `getSameAccountStackState` — which is exactly what scrub's three resolve
 * contexts did not supply, so neither could ever resolve here.
 */
export const CROSS_STACK_INTRINSIC_KEYS = ['Fn::ImportValue', 'Fn::GetStackOutput'] as const;

/**
 * The intrinsic keys {@link IntrinsicFunctionResolver}'s `resolveValue`
 * dispatches on, IN ITS ORDER (issue #2133 review).
 *
 * The pre-pass below must decide which key of a multi-key node the RESOLVER
 * would act on, because a node carrying a higher-precedence sibling never
 * reaches its `Fn::ImportValue` at all. Testing the cross-stack keys first — as
 * the first cut did — makes the pre-pass perform a READ the main resolution
 * never performs, and a read that fails is a refusal over a reference the
 * deploy never made. Isolation (`{ [key]: node[key] }`) does not answer this:
 * it stops the pre-pass resolving something ELSE, it does not stop it resolving
 * something EXTRA.
 *
 * `Condition` is deliberately absent. The resolver's `{Condition: <name>}` arm
 * is gated on `context.conditionResolver`, which only `evaluateConditions`
 * threads; in every context this pre-pass runs under, such a node is an
 * ordinary object property literally named `Condition`.
 *
 * Fenced against the resolver's own dispatch order by
 * `tests/unit/cli/commands/scrub-import-value-secret.test.ts`, so a new
 * intrinsic added there cannot silently leave this copy behind.
 */
const RESOLVER_INTRINSIC_PRECEDENCE = [
  'Ref',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
  'Fn::ImportValue',
  'Fn::GetStackOutput',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Cidr',
] as const;

/** The key `resolveValue` would dispatch on for `node`, or `undefined`. */
export function effectiveIntrinsicKey(node: Record<string, unknown>): string | undefined {
  return RESOLVER_INTRINSIC_PRECEDENCE.find((key) => key in node);
}

/**
 * The refusal a cross-stack read raises when scrub cannot PERFORM it (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)).
 *
 * The value behind such a reference MAY be a secret — a producer stack exporting
 * a `{{resolve:...}}` expression is exactly the shape issue #1934 persists — and
 * scrub learns its plaintext ONLY by performing the read. A read that fails
 * therefore leaves the command with no needle for that value, so a stored
 * plaintext survives and the stack is reported clean. Refusing is the same bar
 * issue #2109 sets for the cross-region case: reporting success over a document
 * scrub could not examine is the one outcome that must not survive.
 *
 * MASKED for the reason `unresolvableForeignScrubSecretError` states — the bag
 * this resolved through is one `pinCrossRegionSecrets` may already have
 * substituted a foreign plaintext into, so a resolver error echoing its input
 * can carry one, and the map is the same one this pass records into.
 */
export function unresolvableCrossStackReadError(
  origin: string,
  stackName: string,
  intrinsic: string,
  path: string,
  cause: unknown,
  secrets: RecordedSecretValues
): CdkdError {
  return new ScrubRefusalError(
    `Scrub of ${displayStackName(stackName)} could not resolve the ${intrinsic} in ${origin}` +
      `${path ? ` at ${maskedIdent(path, secrets)}` : ''}: ` +
      `${maskSecretsInText(describeAwsFailure(cause).detail, secrets)}. ` +
      `Refusing rather than continuing: the value that reference carries may be a secret, and ` +
      `scrub would then have no plaintext to look for — reporting the stack clean over state ` +
      `that still holds it. Deploy the producer stack (or correct the reference) and re-run ` +
      `'${cdkdRemedy('cdkd scrub')}'.`,
    'SCRUB_CROSS_STACK_READ_UNRESOLVED'
  );
}

/**
 * The two sentences the plaintext-producer refusal is built from: what the
 * producer's TEMPLATE is being claimed to say, and the remedy that clears it
 * (issues [#2133](https://github.com/go-to-k/cdkd/issues/2133) review and
 * [#2146](https://github.com/go-to-k/cdkd/issues/2146) review).
 *
 * SEPARATE FROM THE ERROR BUILDER so both can be tested over verdict shapes the
 * walk does not produce today. The one below — `chained` with an EMPTY `via` —
 * is exactly such a shape: unreachable, because `chained` only ever returns
 * from a non-root frame whose `via` therefore has at least one entry, and yet
 * the arm that used to catch it was the WIDENED wording, which asserts "this run
 * could not match '<key>' to a declared output" — false of every `chained`
 * verdict, since a chained one matched the key and left through its value.
 *
 * WHICH SIGNAL KEYS WHICH ARM, since this file has now been round-tripped on it
 * once. The CLAIM keys on `kind`: only `widened` may say "could not say which",
 * and no amount of chain changes that. WHAT the claim names keys on the chain:
 * a `widened` verdict CAN have crossed a re-export, and saying "publishes at
 * least one output from a `{{resolve:...}}` expression" when the walk has just
 * established that none of its outputs does is the same over-claim in the other
 * direction.
 *
 * `via` IS DE-DUPLICATED, and may name the producer itself (issue #2146 review).
 * A chain that returns to the direct producer under a DIFFERENT output key —
 * `A -> B -> A`, or a self-import `A -> A` — is a real walk result, since the
 * visited set is keyed by `(stack, key)` rather than by stack. Left as-is it
 * rendered "producer 'A' ... RE-EXPORTING a value that 'A' declares ... (through
 * 'A')" and a remedy running `cdkd scrub A` two or three times, which reads as a
 * bug in the tool rather than as advice. The claim de-duplicates
 * ORDER-PRESERVINGLY keeping the FIRST occurrence (so the stack that declares
 * the expression stays last, where `chainRoot` reads it), and the remedy keeps
 * the LAST (so the DIRECT producer — the one actually holding the plaintext —
 * stays at the end of the order, where the user must scrub it).
 *
 * Naming the producer inside its own chain is left standing rather than
 * filtered: for `A -> B -> A` it is A that declares the expression, under an
 * output the consumer's key did not match, so dropping it would move the claim
 * onto B, which declares nothing.
 */
export function scrubRefusalWording(
  verdict: SecretExpressionVerdict,
  loggedExportKey: string,
  loggedProducerStack: string,
  loggedVia: readonly string[],
  /** The logged names masking ALTERED — each carries a `***` its stored name does not. */
  maskedNames: ReadonlySet<string> = new Set()
): { templateClaim: string; remedy: string; remedyCommands: string[]; withheldClause: string } {
  const chain = dedupePreservingOrder(loggedVia, 'first');
  const chainRoot = chain[chain.length - 1];
  // The PROSE renders each name with its own boundary (go-to-k/cdkd#3638),
  // and describes one that could wrap into a counterfeit labelled row beside
  // the commands (go-to-k/cdkd#3773); the remedy COMMANDS below take the raw
  // values through the pasteable gate.
  const shownKey = proseName(loggedExportKey, 'export name');
  const shownRoot = chainRoot === undefined ? undefined : proseStackName(chainRoot);
  const through =
    chain.length > 1
      ? ` (through ${chain
          .slice(0, -1)
          .map((s) => proseStackName(s))
          .join(', ')})`
      : '';
  const templateClaim =
    verdict.kind === 'declared'
      ? `declares ${shownKey} from a {{resolve:...}} expression`
      : verdict.kind === 'chained'
        ? chainRoot !== undefined
          ? `publishes ${shownKey} by RE-EXPORTING a value that ${shownRoot} declares ` +
            `from a {{resolve:...}} expression${through}`
          : `publishes ${shownKey} by RE-EXPORTING a value another stack of this app ` +
            `declares from a {{resolve:...}} expression`
        : chainRoot !== undefined
          ? `publishes at least one output that RE-EXPORTS a value ${shownRoot} declares from ` +
            `a {{resolve:...}} expression${through} (this run could not match ` +
            `${shownKey} to a declared output, so it cannot say which)`
          : `publishes at least one output from a {{resolve:...}} expression (this run could not ` +
            `match ${shownKey} to a declared output, so it cannot say which)`;
  // A CHAIN is scrubbed from its HEAD, and naming only the direct producer would
  // send the user into a second refusal: that producer can only store the
  // expression once ITS own producer has been scrubbed down to one.
  const scrubOrder = dedupePreservingOrder(
    [...chain].reverse().concat(loggedProducerStack),
    'last'
  );
  // The commands leave the prose and become labelled lines the caller appends
  // LAST (go-to-k/cdkd#3436). `remedyCommands` is ordered head-of-chain first,
  // which is the order they must be run in.
  const built = scrubOrder.map((name) => scrubCommandFor(name));
  const remedyCommands = built.map((b) => `Scrub with: ${b.command}`);
  // Every hole is explained in the prose, BEFORE the labelled lines. One
  // clause per distinct sentence: two producers withheld for the same reason
  // would otherwise print the same sentence twice. The subject carries no
  // apostrophe: every clause's own quotes come in pairs, so a clause line keeps
  // the quote parity of the lines pasted around it (go-to-k/cdkd#4205).
  const subject = scrubOrder.length > 1 ? 'A producer stack name' : 'The producer stack name';
  // A MASKED name is withheld for its `***`, which the gate reads as a pattern
  // — a reason that is true of the masked spelling and false of the stored
  // name, so it gets its own sentence instead of the gate's.
  const withheldClause = [
    ...new Set(
      built.map((b, i) =>
        b.withheld.length > 0 && maskedNames.has(scrubOrder[i]!)
          ? ` ${subject} holds a value recorded as a secret, so it is ` +
            // A masked name the prose ALSO withholds (it carries whitespace)
            // is not shown at all, so "shown masked" would be false of it.
            (proseWithholds(scrubOrder[i]!) ? 'not shown above and' : 'shown masked and') +
            ` is not named in the command below; list the records as stored with ` +
            `'${cdkdRemedy('cdkd state list', '--long')}' and act on the record whose stack name matches.`
          : withheldTargetClause(b, 'stack', 'cdkd scrub', subject)
      )
    ),
  ].join('');
  const remedy =
    scrubOrder.length > 1
      ? `Scrub the producers first, from the head of the chain, in the order below`
      : `Scrub the producer first`;
  return { templateClaim, remedy, remedyCommands, withheldClause };
}

/**
 * The `cdkd scrub <stack>` a refusal prints on a labelled line.
 *
 * `patternMatched`: scrub resolves its argument through `matchStacks`, so a
 * stack named `Prod*` would select every stack it matches — quoting stops the
 * SHELL expanding it, not cdkd. `plainIdent`: the command sits beside a
 * labelled line, so a name is named only when it cannot spell one — a padded,
 * shell-quoted name wraps on screen into a counterfeit row (go-to-k/cdkd#3773).
 */
function scrubCommandFor(stackName: string): PasteableCommand {
  return pasteableCommand('cdkd scrub', [
    { value: stackName, hole: 'stack', opts: { patternMatched: true, plainIdent: true } },
  ]);
}

/**
 * The same names as a SET, for the one question scrub asks that is about
 * membership rather than order: is this `Properties` bag itself an intrinsic
 * NODE, which the resolver must be handed whole?
 *
 * DERIVED, never re-listed. Review of go-to-k/cdkd#3215 caught a hand-written
 * copy of these seventeen names forty lines from this constant — a second
 * spelling of one fact, in one file, each with its own fence. The membership is
 * identical by construction now, so the drift class does not exist and
 * `scrub-import-value-secret.test.ts`'s existing fence against the resolver
 * covers both uses.
 *
 * NOT `HANDLED_INTRINSIC_KEYS` from the resolver, which answers a different
 * question and deliberately carries `Fn::Transform` — handled so a stray
 * already-expanded macro does not hard-error, but never DISPATCHED on. Routing
 * a multi-key bag whole because it carries that key is the spurious-name case
 * that re-opens go-to-k/cdkd#3196.
 */
export const RESOLVER_DISPATCH_KEYS = new Set<string>(RESOLVER_INTRINSIC_PRECEDENCE);

/**
 * `values` with repeats removed, keeping either the FIRST or the LAST occurrence
 * of each and preserving the order of the ones kept.
 */
function dedupePreservingOrder(values: readonly string[], keep: 'first' | 'last'): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const ordered = keep === 'last' ? [...values].reverse() : values;
  for (const value of ordered) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return keep === 'last' ? out.reverse() : out;
}

/**
 * The refusal a cross-stack read raises when it SUCCEEDED but the PRODUCER's
 * own state record still stores the PLAINTEXT (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133) review).
 *
 * That producer state is precisely the population `cdkd scrub` exists for:
 * state an older binary wrote. Reading it hands the consumer a bare string,
 * nothing lands in `recordedSecretValues`, `totalSecrets` stays 0 and the
 * consumer is reported "No plaintext secrets found" while its record still
 * holds that plaintext. That is the same silent success the issue exists to
 * kill, reached one step later.
 *
 * There is no correct value to write here instead. What scrub must persist for
 * an imported secret is the PRODUCER's `{{resolve:...}}` expression, and that
 * expression exists only in the producer's state — the consumer's template
 * carries `{"Fn::ImportValue": ...}`, which is a REFERENCE, not an expression.
 * Writing the reference into a state leaf would fabricate an expression that
 * `Fn::ImportValue` and the exports index re-apply verbatim to further
 * consumers, the #1934 BREAK class this file already refuses one class over.
 * So: refuse, and name the fix that actually works — scrub the producer first,
 * which turns its stored plaintext into the expression this read then resolves.
 *
 * Exported for unit testing: its paste case (go-to-k/cdkd#4205) renders the
 * message with a planted stack name directly, without a scrub run.
 */
export function plaintextProducerCrossStackReadError(
  /** Rendered for prose beside labelled lines: {@link CrossStackReadOrigin}'s `prose`. */
  origin: string,
  stackName: string,
  intrinsic: string,
  path: string,
  producerStack: string,
  exportKey: string,
  verdict: SecretExpressionVerdict,
  secrets: RecordedSecretValues
): CdkdError {
  // MASKED, for the reason its sibling `unresolvableCrossStackReadError`
  // already gives (issue #2133 review — this builder interpolated both
  // identifiers RAW while the sibling masked).
  //
  // `exportKey` is the REACHABLE half: it is a RESOLVED export name, so an
  // `Fn::ImportValue` over a `{{resolve:...}}` string (or an `Fn::Sub` /
  // `Fn::Join` assembling one) makes it a resolved secret verbatim — which is
  // exactly why the resolver half of this same lane masks resolved export names
  // at EVERY log site. `maskSecretsInError` at `scrubStack`'s boundary is the
  // outermost net, not the rule, and it is provably NOT sufficient here:
  // `allRecordedSecrets` DROPS every needle below `MIN_NEEDLE_LENGTH`, while
  // the whole-value arm of `maskSecretsInText` matches at any length, so a
  // short secret is masked by this call and by nothing else.
  //
  // `producerStack` is masked because it is REACHABLE too — not, as an earlier
  // revision of this comment claimed, merely for uniformity with `exportKey`.
  // The claim held for ONE of the two arms that reach here. An
  // `Fn::ImportValue` producer name comes from the state-bucket listing
  // (`recordImport` is handed `entry.producerStack` / `refStack`), and that is
  // never a resolved value. An `Fn::GetStackOutput` producer name is
  // RESOLVED before it is recorded: `recordOutputRead(context, stackName, ...)`
  // is fed `await this.resolveValue(args['StackName'], context)`, so an
  // `Fn::Sub` / `Fn::Join` assembling a `{{resolve:...}}` into `StackName`
  // makes the recorded producer name a resolved secret exactly the way
  // `exportKey` can be.
  //
  // Nothing leaks today, because both identifiers are masked at every site
  // that prints them. What was wrong was the RATIONALE — and a wrong one is
  // worse here than none at all, since "never a resolved value" reads as
  // licence to drop the call the next time this line is touched.
  const loggedExportKey = maskSecretsInText(exportKey, secrets);
  const loggedProducerStack = maskSecretsInText(producerStack, secrets);
  // The claim about the producer's TEMPLATE is only as precise as the match
  // that produced it (issue #2133 review). `declared` matched an output by name
  // or by literal `Export.Name`, so naming the key is exact; `widened` matched
  // NO output — an intrinsic `Export.Name` scrub cannot reproduce — and the
  // verdict came from scanning every output of the producer, so asserting that
  // this key in particular is declared from an expression would be a statement
  // the code did not check.
  //
  // The RE-EXPORT case (issue #2146): the direct producer's own outputs carry no
  // `{{resolve:`, and the evidence came from following its re-exported import up
  // to the stack that does declare one. The message names THAT stack, because
  // the remedy differs — see below.
  //
  // Both halves are built by {@link scrubRefusalWording}, which is where the
  // `widened` / `chained` split and the chain de-duplication live.
  const maskedNames = new Set<string>();
  const loggedVia = verdict.via.map((s) => {
    const logged = maskSecretsInText(s, secrets);
    if (logged !== s) maskedNames.add(logged);
    return logged;
  });
  if (loggedProducerStack !== producerStack) maskedNames.add(loggedProducerStack);
  // The wording dedupes the chain by its LOGGED spelling, so a masked name and
  // a stack genuinely named that way (`Prod-***`) collapse into one command.
  // The secret sentence would be false of the genuine one, so an ambiguous
  // spelling keeps the gate's own reason, which is true of the spelling shown.
  for (const raw of [producerStack, ...verdict.via]) maskedNames.delete(raw);
  const { templateClaim, remedy, remedyCommands, withheldClause } = scrubRefusalWording(
    verdict,
    loggedExportKey,
    loggedProducerStack,
    loggedVia,
    maskedNames
  );
  const rerun = scrubCommandFor(stackName);
  // On a line of their OWN, ahead of the labelled lines: each clause points at
  // `cdkd state list --long`, and the prose line above DISPLAYS the names, so
  // a pasted span covering both would carry a command beside a displayed
  // value (the go-to-k/cdkd#4205 paste rule).
  const withheld = (
    withheldClause + withheldTargetClause(rerun, 'stack', 'cdkd scrub', 'This stack name')
  ).trim();
  return new ScrubRefusalError(
    `Scrub of ${proseStackName(stackName)} resolved the ${intrinsic} in ${origin}` +
      `${path ? ` at ${proseName(maskSecretsInText(path, secrets), 'property path')}` : ''} to a PLAINTEXT value: the producer stack ` +
      `${proseStackName(loggedProducerStack)} ` +
      `${templateClaim}, but its own state still stores ` +
      `the resolved plaintext rather than that expression. scrub has no expression to write in ` +
      `this stack's place, so it cannot redact the imported secret and must not report this ` +
      `stack clean. ${remedy}, then re-run scrub for this stack — the read will then ` +
      `return the expression and this stack is scrubbed normally.` +
      (withheld === '' ? '' : `\n${withheld}`) +
      `\n${remedyCommands.join('\n')}` +
      `\nThen re-run: ${rerun.command}`,
    'SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT'
  );
}
