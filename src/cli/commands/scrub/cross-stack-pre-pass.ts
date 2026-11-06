import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { getLogger } from '../../../utils/logger.js';
import {
  CrossAccountSecretRefusalError,
  MalformedProducerRecordRefusalError,
} from '../../../utils/error-handler.js';
import {
  type IntrinsicFunctionResolver,
  carriesDynamicReference,
  type ResolverContext,
} from '../../../deployment/intrinsic-function-resolver.js';
import { errorCauseChain, maskSecretsInText } from '../../../deployment/secret-redaction.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import {
  isReadableBag,
  producerCoordinateKey,
  producerRecordKey,
} from '../../../state/malformed-resources-bag.js';
import {
  CROSS_STACK_INTRINSIC_KEYS,
  effectiveIntrinsicKey,
  unresolvableCrossStackReadError,
  plaintextProducerCrossStackReadError,
} from './cross-stack-refusals.js';
import {
  type SecretExpressionVerdict,
  storedValueCarriesNoPlaintext,
  producerPublishesSecretExpression,
  buildExportOwnerIndex,
} from './producer-expression.js';
import type { CrossStackPrePassFindings } from './cross-stack-findings.js';
import { maskedIdent, type CrossStackReadOrigin } from './abandoned-scan.js';

/**
 * Build the CROSS-STACK pre-pass for ONE stack's scrub (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)).
 *
 * WHY THIS RUNS AT ALL, given the wiring in `scrubStack` already lets the main
 * resolution perform these reads. The wiring is what makes an
 * `Fn::ImportValue`-sourced secret RESOLVE; this pass is what makes a FAILED
 * one LOUD, and what catches a SUCCEEDING one that produced no needle. A
 * cross-stack read that throws inside `resolver.resolve` lands in the caller's
 * best-effort `catch { logger.debug(...) }`, and that catch cannot tell "a
 * `Ref` to a resource that is not in state" — which it exists for — from "the
 * producer's state could not be read", which silently costs the command its
 * needle. Lifting the second class OUT of the catch is the same placement issue
 * #2109 uses for its own refusals, and it keeps the catch doing its job:
 * everything it still swallows is now provably NOT a cross-stack read.
 *
 * THREE OUTCOMES per reference, and the split is the whole design:
 * - the read FAILS for a reason a user can fix (producer not deployed, wrong
 *   reference, an `AccessDenied` on the producer's state or on
 *   `cloudformation:ListExports`, an unassumable `RoleArn`) — REFUSE the stack.
 *   A re-run after the fix scrubs it, so refusing costs reachability only until
 *   the cause is addressed.
 * - the read is DECLINED BY DESIGN (`CrossAccountSecretRefusalError`) — record
 *   an UNVERIFIABLE finding, scrub the rest of the stack, and let the run exit
 *   non-zero. No user action can make that read succeed, so refusing the whole
 *   stack would strand every OTHER secret in it forever — a reachability
 *   regression against the pre-#2133 best-effort behaviour, in the command that
 *   exists to remediate. This is the `secretBearingKeys` treatment (issue
 *   #1919), applied to the same shape of finding: real, reported, unremediable.
 *   The match is on that SUBCLASS, never on `IntrinsicResolutionRefusalError`:
 *   five of its six throw sites are USER-FIXABLE and are reachable from here
 *   whenever a cross-stack node's ARGUMENT is an `Fn::Sub` / `Fn::GetAtt` /
 *   `Fn::Split` (`resolveSub` re-raises the class), so matching the base class
 *   downgraded a fixable refusal to a finding and let scrub print
 *   `No plaintext secrets found` and exit 0 over surviving plaintext.
 * - the read SUCCEEDS but the PRODUCER's own state record still holds the
 *   plaintext, for an export the producer's template declares from a
 *   `{{resolve:...}}` expression — REFUSE, see
 *   {@link plaintextProducerCrossStackReadError}.
 *
 * Each node is resolved on its OWN — `{ [key]: node[key] }` rather than the
 * enclosing object — so a bag carrying an unrelated sibling key cannot make
 * this pass resolve something else, and so a failure names the cross-stack read
 * rather than whatever the whole node resolves to. Which key of a multi-key
 * node is even eligible is decided by {@link RESOLVER_INTRINSIC_PRECEDENCE},
 * mirroring the resolver — so for the CHOICE OF KEY the pass never reads
 * through an intrinsic the main resolution would ignore.
 *
 * That is the whole of the invariant, and it is deliberately narrower than
 * "this pass performs no read the main resolution would not" (issue #2133
 * review — the earlier, overstated wording). `resolveValue` walks a plain
 * object's properties SEQUENTIALLY and aborts the whole bag at the first one
 * that throws, and it THROWS on an unknown intrinsic (`Fn::ToJsonString`,
 * `Fn::ForEach`) before descending into its argument at all; this pass resolves
 * each node on its own and keeps walking in both cases. So it can read a
 * reference the main resolution never reaches — after a sibling `Ref` to a
 * resource absent from state, which is the routine case, or beneath an
 * intrinsic cdkd cannot resolve. The DIRECTION is safe (the deploy made those
 * reads, so refusing over one names a real unscrubbed producer rather than a
 * fabricated one) but the sentence is load-bearing for the refusal, so it is
 * stated as what it is rather than as the stronger claim.
 *
 * The bag is NOT rewritten. The main resolution re-resolves these references
 * itself, and the S3 reads behind them are shared with this pass by the
 * memoizing backend view `scrubStack` builds (issue #2133 review — before that
 * every reference cost `listStacks()` plus up to N `getState()` TWICE). What
 * not rewriting buys back is the whole class of hazard a substituted value
 * carries: a resolved cross-stack value that is itself intrinsic- or
 * reference-shaped would be re-interpreted by the stack's own resolver, which
 * is the shape `SCRUB_SECRET_RESOLUTION_REINTRODUCED_TOKEN` guards against one
 * class over. The needles this records survive the main resolution failing for
 * an unrelated reason, since `recordedSecretValues` is filled in place.
 *
 * `Fn::If` is walked the way {@link IntrinsicFunctionResolver} walks it — the
 * SELECTED branch only, with an unknown condition selecting the FALSE branch,
 * mirroring `resolveIf`. Reading a reference the main resolution would never
 * touch would refuse a stack over a conditional import the deploy never made.
 * A MALFORMED `Fn::If` (args not a 3-tuple) is walked with refusals DISARMED
 * rather than skipped: which branch is live is unknowable, so a read inside it
 * may be one the deploy never made — the exact hazard the selected-branch
 * mirror exists to prevent — but any needle it does yield is still worth having.
 */
export function makeCrossStackPrePass(deps: {
  stackName: string;
  resolver: IntrinsicFunctionResolver;
  producerTemplates: ReadonlyMap<string, CloudFormationTemplate>;
  findings: CrossStackPrePassFindings;
  logger: ReturnType<typeof getLogger>;
}): (
  bag: unknown,
  context: ResolverContext,
  origin: CrossStackReadOrigin,
  opts?: { canRefuse?: boolean }
) => Promise<void> {
  const { stackName, resolver, producerTemplates, findings, logger } = deps;
  // One rendering of this stack's name for every message below (go-to-k/cdkd#3638).
  const shownStackName = displayStackName(stackName);
  // Built once per stack scrub: every cross-stack read this pass performs asks
  // the same question of the same set of templates (issue #2146).
  const exportOwners = buildExportOwnerIndex(producerTemplates);
  // ...and the ANSWER is memoized per (producer, key) too (issue #2146 review).
  // The walk is pure in `producerTemplates` / `exportOwners`, which do not
  // change during one stack's scrub, while `readOne` runs once per REFERENCE
  // OCCURRENCE — so a template importing one export at ten leaves re-walked the
  // reachable space and `JSON.stringify`d every output of a widened root ten
  // times.
  const verdicts = new Map<string, SecretExpressionVerdict>();
  /**
   * Producer records already reported as having an unreadable `outputs` map, so
   * that line is emitted once per RECORD rather than once per reference
   * (review of go-to-k/cdkd#3206 round 4).
   *
   * Beside `verdicts` on purpose: both are per-pre-pass memos keyed by a
   * producer coordinate, and both would repeat per reference without one.
   * Measured before this: a consumer template with three `Fn::GetStackOutput`
   * reads of ONE damaged producer emitted three identical ~600-character
   * paragraphs, and a `--all` run repeated the set per consumer stack.
   */
  const warnedDamagedProducers = new Set<string>();
  const secretExpressionVerdict = (stack: string, key: string): SecretExpressionVerdict => {
    const id = producerCoordinateKey(stack, key);
    let verdict = verdicts.get(id);
    if (!verdict) {
      verdict = producerPublishesSecretExpression(producerTemplates, exportOwners, stack, key);
      verdicts.set(id, verdict);
    }
    return verdict;
  };

  /**
   * Is this a refusal NO RE-RUN can clear (issue #2133 review)?
   *
   * The predicate is the SUBCLASS, not `IntrinsicResolutionRefusalError`. That
   * class has six throw sites and only ONE — `resolveGetStackOutput`'s
   * cross-account arm — is permanent; the other five (a stale placeholder ARN,
   * an unknown account id, an unenriched `Fn::GetAtt`, `--strict-getatt`, a
   * malformed `Fn::Split`) are all fixed by editing the template or deploying
   * the producer. They are REACHABLE here, because `resolveSub` re-raises the
   * class, so any cross-stack node whose ARGUMENT is an `Fn::Sub` /
   * `Fn::GetAtt` / `Fn::Split` can carry one up to this catch. Matching the
   * base class downgraded every one of them to a finding logged as "cdkd
   * declines this read by design, so no re-run can change it" — false — and
   * scrub then printed `No plaintext secrets found` and exited 0 without
   * `--fail` while the consumer's state.json still held the imported plaintext.
   *
   * The CAUSE CHAIN rather than a bare `instanceof`: the refusal reaches this
   * catch through `resolver.resolve`, which wraps in several places, and a
   * top-link-only test silently reclassifies a wrapped permanent refusal as
   * user-fixable — i.e. refuses the whole stack over something no user can fix.
   */
  const isByDesignRefusal = (err: unknown): boolean =>
    err instanceof Error &&
    errorCauseChain(err).some((link) => link instanceof CrossAccountSecretRefusalError);

  /**
   * Is this a refusal over ANOTHER STACK's damaged record (issue
   * go-to-k/cdkd#3207)?
   *
   * A SECOND predicate rather than a widening of {@link isByDesignRefusal},
   * because the two classify the same `err` into DIFFERENT sentences and
   * different exit-code lists, and only one of them can honestly say "no
   * re-run can change it".
   *
   * Why this arm has to exist at all. Before go-to-k/cdkd#3207 the deploy-side
   * resolver RESOLVED an `Fn::GetStackOutput` against a non-object producer
   * bag — `Object.hasOwn('abcdef', '0')` is `true` — so a damaged producer
   * reached {@link storedProducerValue}, whose own guard records the finding
   * this arm now records. Closing the resolver is correct (that value is
   * APPLIED to a live system by a deploy) but it moves the refusal UP: without
   * this branch the read lands on `unresolvableCrossStackReadError` below and
   * refuses the whole stack, so a consumer's own plaintext would stay in
   * `state.json` over a producer record its owner may not be able to repair —
   * exactly the trade `docs/design/3192-outputs-consumers.md` §6 decided
   * against, silently reversed by the fix one layer up.
   *
   * SAME two lists as the classifier's arm, deliberately: `unverifiable` gates
   * the clean verdict, and `damagedProducerRecords` carries the UNCONDITIONAL
   * exit 2 that shape had before either guard existed.
   *
   * CAUSE CHAIN, not a bare `instanceof`, for the reason
   * {@link isByDesignRefusal}'s note gives — `resolver.resolve` wraps.
   */
  const isMalformedProducerRefusal = (err: unknown): boolean =>
    err instanceof Error &&
    errorCauseChain(err).some((link) => link instanceof MalformedProducerRecordRefusalError);

  return async function resolveCrossStackReads(bag, context, origin, opts): Promise<void> {
    const canRefuse = opts?.canRefuse ?? true;
    // The needle set this pass MASKS its messages against. It is no longer part
    // of any verdict (issue #2133 review replaced the needle-count
    // discriminator with a direct read of the producer's stored value), so the
    // `?? new Map()` fallback now means "nothing to mask against" rather than
    // "every read refuses".
    const secrets = context.recordedSecretValues ?? new Map<string, string>();

    /**
     * The producer this reference actually resolved through, and the KEY it
     * matched — read back out of the resolver's own recording bags.
     *
     * Keyed on the intrinsic UNDER TEST rather than "imports first, then output
     * reads": `resolveImportValue` / `resolveGetStackOutput` each resolve their
     * ARGUMENTS before recording their own read, so a nested cross-stack read
     * inside the argument lands in the OTHER family's bag (or earlier in the
     * same one). Preferring imports unconditionally made an
     * `Fn::GetStackOutput` whose `StackName` contains an `Fn::ImportValue`
     * report the INNER producer.
     *
     * `.at(-1)` for the same reason within one family: the outer read is
     * recorded LAST, after its argument has resolved.
     *
     * An empty bag means the value did NOT come from a cdkd state record, and
     * the two arms that produce one are NOT unreadable for the same reason
     * (issue #2133 review — one rationale used to cover both, and it was false
     * of the second):
     *
     * - the CloudFormation `ListExports` / `DescribeStacks` FALLBACKS record
     *   nothing deliberately, a CFn-managed producer being a weak reference.
     *   Here "no expression to restore" is literally true: the value came from
     *   CloudFormation, which cdkd never redacted, so no `{{resolve:...}}`
     *   expression exists anywhere for scrub to write in its place.
     * - the CROSS-ACCOUNT `Fn::GetStackOutput` arm records nothing for a
     *   different reason, and a post-#1934 producer in the other account DOES
     *   store the expression — which is precisely why
     *   `CrossAccountSecretRefusalError` exists, and why it fires BEFORE this
     *   point whenever the stored value carries one. What can reach here is a
     *   value that carried none, and scrub cannot classify it any further: the
     *   producer's `state.json` lives in another account and the only
     *   credentials in hand are the consumer's, so reading it is the
     *   wrong-account lookup that refusal exists to prevent.
     *
     * The OUTCOME is the same today either way — a cross-account producer is
     * never in `appStacks`, so the `producerTemplates.has(...)` return below
     * fires first regardless — but a future change that widened `producerTemplates` would
     * be relying on this sentence, so it must not claim the second arm has no
     * expression behind it.
     *
     * Residual: an OUTER read that fell through to a CloudFormation fallback
     * while its ARGUMENT performed a same-family cdkd read leaves the inner
     * entry last, so the check below consults the wrong producer. Bounded by
     * the key test — the inner key must also exist in the inner producer's
     * outputs, which it does — and it can only produce a false REFUSAL naming a
     * real unscrubbed producer, never a false clean.
     */
    const recordedProducer = (
      key: string,
      probe: ResolverContext
    ): { stack: string; region: string; key: string } | undefined => {
      if (key === 'Fn::GetStackOutput') {
        const read = probe.recordedOutputReads?.at(-1);
        return read
          ? { stack: read.sourceStack, region: read.sourceRegion, key: read.outputName }
          : undefined;
      }
      const imported = probe.recordedImports?.at(-1);
      return imported
        ? { stack: imported.sourceStack, region: imported.sourceRegion, key: imported.exportName }
        : undefined;
    };

    /**
     * The producer's STORED value for `key` — what its `state.json` actually
     * holds, as opposed to what the read RETURNED.
     *
     * `undefined` when the producer's record cannot be read or does not carry
     * the key, which is treated as "cannot classify" by the caller rather than
     * as evidence of anything. Both are near-unreachable on the arms that get
     * here (the read just succeeded against that record, through the SAME
     * memoized `getState` promise this call resolves), so the read costs no
     * extra AWS call.
     */
    const storedProducerValue = async (
      producer: { stack: string; region: string; key: string },
      backend: ResolverContext['stateBackend'],
      // The SAME gate the by-design branch applies FIRST, threaded here for the
      // same reason (review of go-to-k/cdkd#3206 round 6). A finding is a
      // PERMANENT non-clean verdict for the run, and the positions carrying
      // `canRefuse: false` — a condition-suppressed output, a malformed
      // `Fn::If` — are exactly the ones that wrote no `state.outputs` key and
      // may name a read the deploy never made. Recording one there produces a
      // standing `--dry-run --fail` failure over a reference with nothing at
      // risk, which is what `isOutputSuppressed` exists to spare.
      nodeCanRefuse: boolean
    ): Promise<{ stored: unknown } | undefined> => {
      if (!backend) return undefined;
      // Masked first, then bounded, once for every message below.
      const shownProducer = displayStackName(maskSecretsInText(producer.stack, secrets));
      let loaded: Awaited<ReturnType<NonNullable<ResolverContext['stateBackend']>['getState']>>;
      try {
        loaded = await backend.getState(producer.stack, producer.region);
      } catch (err) {
        logger.debug(
          `Scrub of ${shownStackName}: could not re-read producer ` +
            `${shownProducer} ` +
            `(${displayIdent(producer.region)}) to classify its stored value: ` +
            `${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`
        );
        return undefined;
      }
      const outputs = loaded?.state?.outputs;
      // `isReadableBag`, not truthiness (review of go-to-k/cdkd#3206). This is
      // a FOREIGN producer's bag — the stack being scrubbed is guarded at its
      // own load, this record is not — and `producer.key in 'abcdef'` is a
      // bare `TypeError` that escapes: the `try` above ends at the `catch`
      // that logs the re-read failure, so nothing here catches it.
      //
      // "No verdict" (`undefined`) rather than a refusal, because this is a
      // classification of somebody ELSE's record: refusing would strand THIS
      // stack's own plaintext over a damaged producer the user may not even
      // own. The existing pre-pass already treats `undefined` as "could not
      // classify" and falls back to the producer's TEMPLATE evidence.
      // `outputs === undefined` first for the TYPE, not for a second verdict:
      // `isReadableBag` returns `boolean` rather than a type predicate, so it
      // narrows nothing and `Object.hasOwn` would not compile. It already
      // answers false for `undefined`, so no verdict moves — the same shape
      // `outputs-diff.ts` carries for the same reason.
      //
      // DAMAGED is WARNED, ABSENT is not, and the split is the point (review
      // of go-to-k/cdkd#3206). Before the guard, a damaged producer bag
      // aborted scrub with a raw `TypeError`; degrading that to a silent
      // `undefined` would trade a loud wrong answer for a quiet one, and this
      // is the ONE place in this change where a damaged record would otherwise
      // be tolerated without being named. An ABSENT bag, or one that simply
      // does not carry the key, is ORDINARY — a stale index entry, a producer
      // that never published that name — and stays unmentioned.
      //
      // WHAT REACHES THIS ARM CHANGED IN go-to-k/cdkd#3207, and the honest
      // statement is that inside `cdkd scrub` it is now DEFENCE IN DEPTH. The
      // route that made it reachable was the resolver's `Fn::GetStackOutput`
      // arm answering from a non-object bag (`Object.hasOwn('abcdef', '0')` is
      // `true`), and that arm now REFUSES — caught by
      // `isMalformedProducerRefusal` above, which records the SAME two
      // findings this arm does. Scrub's other route, the `Fn::ImportValue`
      // state scan, needs `importableOutputKeys` to have answered off the same
      // record, which requires a READABLE bag. So what is left here is the two
      // reads DISAGREEING — this classifier re-reads the producer's record
      // separately from the resolver — and that is worth keeping rather than
      // deleting on the strength of an enumeration. The `exportIndex` arm that
      // resolves WITHOUT reading the producer's record reaches it in principle
      // too, but scrub deliberately supplies no index.
      if (outputs !== undefined && !isReadableBag(outputs)) {
        // ONCE PER PRODUCER RECORD, not per reference: a consumer template
        // with three `Fn::GetStackOutput` reads of one damaged producer emitted
        // three identical ~600-character paragraphs, and a `--all` run repeated
        // the set per consumer stack (measured, review round 4).
        // A position that cannot refuse gets the `debug` treatment its
        // by-design sibling gives, and records NOTHING -- see the parameter's
        // own note. AHEAD of the dedupe `Set`, so a suppressed position never
        // consumes the one-warning-per-record budget a refusable one needs.
        if (!nodeCanRefuse) {
          logger.debug(
            `Scrub of ${shownStackName}: producer ` +
              `${shownProducer} (${displayIdent(producer.region)}) has no ` +
              `readable 'outputs' map, and this position cannot refuse.`
          );
          return undefined;
        }
        // ONE spelling, shared with `local-state-loader.ts`'s sibling Set — see
        // {@link producerRecordKey} for why it ENCODES rather than separates.
        const seenKey = producerRecordKey(producer.stack, producer.region);
        if (!warnedDamagedProducers.has(seenKey)) {
          warnedDamagedProducers.add(seenKey);
          // A FINDING, and this is a REGRESSION GUARD rather than an
          // improvement (review round 5). At the merge base this site read
          // `!outputs || !(producer.key in outputs)`, and BOTH damaged shapes
          // were already non-clean: an ARRAY bag with `OutputName: '0'`
          // satisfied `'0' in [...]`, returned the plaintext element, and threw
          // `plaintextProducerCrossStackReadError` (exit 2); a STRING bag threw
          // a raw `TypeError` that escaped on purpose, the pre-pass sitting
          // outside the best-effort catch precisely so scrub cannot report
          // success over a state file it could not examine.
          //
          // Guarding the read WITHOUT recording a finding would have turned
          // both into `No plaintext secrets found`, exit 0, while the
          // consumer's record still held the imported plaintext — the
          // false-clean class this whole change exists to prevent,
          // reintroduced by its own fix. `--dry-run --fail` reads the exit
          // code, not the warning.
          const detail =
            `the stored value of producer ${shownProducer} ` +
            `(${displayIdent(producer.region)}), whose 'outputs' map cannot be read`;
          findings.unverifiable.push(detail);
          // ...and into the EXIT-CODE list as well. `unverifiable` alone gates
          // the clean-verdict line and `--fail`; this second list is what
          // restores the UNCONDITIONAL exit 2 the merge base gave this shape,
          // for the reason its own declaration records. Both, not either: the
          // summary must still name the stack, and the run must still refuse.
          findings.damagedProducerRecords.push(detail);
          // MASKED, like every neighbouring line in this function: a producer
          // STACK NAME is a needle whenever a stack is named after a value this
          // pass resolved, and this is the only line here that runs at WARN.
          //
          // scrub's OWN sentence, not `malformedExportSourceWarning`: that text
          // is about an exports-index REBUILD ("contributes NO exports to this
          // region's index", "continuing with the other producers"), and scrub's
          // pre-pass rebuilds no index and iterates no producers. Reusing it
          // stated a consequence that does not happen here and never stated the
          // one that does.
          logger.warn(
            `Scrub of ${shownStackName}: producer ` +
              `${shownProducer} (${displayIdent(producer.region)}) has no ` +
              `readable 'outputs' map, so its stored value could NOT be classified — this run ` +
              `cannot tell whether it still holds plaintext for the value ${shownStackName} imports ` +
              `from it. ${shownStackName} is scrubbed for everything else. Repair that record and ` +
              `scrub it first.`
          );
        }
        return undefined;
      }
      if (outputs === undefined) return undefined;
      if (!Object.hasOwn(outputs, producer.key)) return undefined;
      return { stored: outputs[producer.key] };
    };

    const readOne = async (
      key: string,
      node: Record<string, unknown>,
      path: string,
      nodeCanRefuse: boolean
    ): Promise<void> => {
      // A FRESH pair of recording bags per read, so the producer this
      // particular reference resolved through is readable back out. They are
      // the resolver's own bookkeeping (`recordImport` / `recordOutputRead`),
      // not scrub's, and scrub persists neither — it only asks WHO answered.
      const probe: ResolverContext = {
        ...context,
        recordedImports: [],
        recordedOutputReads: [],
      };
      // WHERE THE READ IS, spelled once and hoisted above the `try` so all
      // nine log/finding sites below share one spelling (issue #2163 review --
      // the first cut hoisted it only past the `catch`, leaving four re-spelled
      // copies of the identical expression behind).
      const where = `${key} in ${origin.text}${path ? ` at ${maskedIdent(path, secrets)}` : ''}`;
      try {
        await resolver.resolve({ [key]: node[key] }, probe);
      } catch (err) {
        // The `!nodeCanRefuse` test runs FIRST, ahead of the by-design branch
        // (issue #2133 review). A finding is a PERMANENT exit-1 for the run,
        // and the positions that carry `canRefuse: false` — a
        // condition-suppressed output, a malformed `Fn::If` — are exactly the
        // ones that wrote no `state.outputs` key and may name a read the deploy
        // never made. Recording a finding there produces a standing failure
        // over a reference with nothing at risk, which is what
        // {@link isOutputSuppressed} exists to spare.
        if (!nodeCanRefuse) {
          logger.debug(
            `Scrub of ${shownStackName}: ${where} could not be resolved, and this position ` +
              `cannot refuse: ${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`
          );
          return;
        }
        if (isByDesignRefusal(err)) {
          const detail = `${where}: ${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`;
          findings.unverifiable.push(detail);
          logger.warn(
            `Scrub of ${shownStackName} cannot verify ${detail} — cdkd declines this read by design, ` +
              `so no re-run can change it. The rest of the stack is still scrubbed; this stack ` +
              `is NOT reported clean.`
          );
          return;
        }
        // AFTER the by-design branch and BEFORE the refusal, which is the only
        // position that preserves both classifications: the two classes are
        // disjoint (neither subclass extends the other), so the order between
        // them is stable, while falling through to the refusal is what
        // go-to-k/cdkd#3207 must not do. See {@link isMalformedProducerRefusal}.
        if (isMalformedProducerRefusal(err)) {
          const detail = `${where}: ${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`;
          findings.unverifiable.push(detail);
          // Both lists, for the reason the classifier's arm states: the first
          // gates the clean verdict and `--fail`, the second restores the
          // UNCONDITIONAL exit 2 this shape carried before it was guarded.
          findings.damagedProducerRecords.push(detail);
          logger.warn(
            `Scrub of ${shownStackName} cannot verify ${detail} — the PRODUCER's state record is ` +
              `malformed or truncated, so this run cannot tell whether that producer still ` +
              `holds the plaintext. The rest of the stack is still scrubbed; this stack is NOT ` +
              `reported clean. Repair the producer's record and scrub it first, then re-run.`
          );
          return;
        }
        throw unresolvableCrossStackReadError(origin.text, stackName, key, path, err, secrets);
      }
      // Every read this node performed, the argument's nested ones included —
      // the verdict on a stored entry this run could not repair asks which
      // reads today's template makes (go-to-k/cdkd#3382).
      for (const entry of probe.recordedImports ?? []) {
        findings.performedReads.imports.push({ entry, canRefuse: nodeCanRefuse });
      }
      for (const entry of probe.recordedOutputReads ?? []) {
        findings.performedReads.outputReads.push({ entry, canRefuse: nodeCanRefuse });
      }
      // FIVE declining arms used to return in silence -- issue #2163 named
      // three of them and reasoned from "every arm that classifies and then
      // declines logs a debug line" that the failing live run must have taken
      // one of those three. That premise was false for the other two, which is
      // why isolating #2163 cost four real-AWS runs and still did not settle
      // which one fired. All five name themselves below.
      const producer = recordedProducer(key, probe);
      if (!producer) {
        logger.debug(
          `Scrub of ${shownStackName}: ${where} resolved, but the resolver recorded no cdkd ` +
            `cross-stack read for it — the value came from a CloudFormation fallback or a ` +
            `cross-account arm that records nothing, so scrub cannot name a producer to ` +
            `classify. Not classified as a plaintext producer.`
        );
        return;
      }
      // MASKED, for the reason {@link plaintextProducerCrossStackReadError} already
      // gives for the REFUSAL that shares these two identifiers, and it applies
      // with more force here: a `logger.debug` line has no boundary net at all,
      // where the refusal at least passes through `maskSecretsInError` at
      // `scrubStack`'s edge.
      //
      // `producer.key` is the REACHABLE half: it is `recordedImports.at(-1)
      // .exportName` / `recordedOutputReads.at(-1).outputName`, i.e. the
      // POST-resolution name, and `resolveImportValue` sets it from
      // `resolveValue(importValueArg)` -- so an `Fn::ImportValue` over an
      // `Fn::Sub` / `Fn::Join` / bare string assembling a `{{resolve:...}}`
      // makes it a resolved secret verbatim. The needle is present by then:
      // `probe` shares this function's `secrets` map object (it spreads
      // `context`), the resolver fills that map IN PLACE, and the
      // `resolver.resolve` call above is what performs the resolution.
      // `maskSecretsInError` would not cover it anyway -- `allRecordedSecrets`
      // DROPS every needle below `MIN_NEEDLE_LENGTH`, while the whole-value arm
      // of `maskSecretsInText` matches at any length.
      //
      // `producer.stack` is masked because it is REACHABLE too — not merely
      // for uniformity, which is what an earlier revision of this comment
      // claimed. That claim held for ONE of the two arms `recordedProducer`
      // reads. `Fn::ImportValue` takes the producer name from the state-bucket
      // listing, so it really is a state record's own stack name.
      // `Fn::GetStackOutput` RESOLVES it first:
      // `recordOutputRead(context, stackName, ...)` is fed
      // `await this.resolveValue(args['StackName'], context)`, so an
      // `Fn::Sub` / `Fn::Join` assembling a `{{resolve:...}}` into `StackName`
      // makes `producer.stack` a resolved secret exactly the way
      // `producer.key` can be.
      //
      // Nothing leaks today — both are masked at every site below. The
      // RATIONALE was the defect, and a wrong one is worse than none: "never a
      // resolved value" reads as licence to drop the mask.
      //
      // `producer.region` is the one that genuinely cannot carry a secret, and
      // it is interpolated raw for that reason. `Fn::GetStackOutput` gates its
      // region through `isClientSafeRegion` (`/^[a-z0-9][a-z0-9-]{0,30}$/`,
      // which no `{{resolve:...}}` token can satisfy) and THROWS rather than
      // falling back; `Fn::ImportValue` takes it from the same state-bucket
      // listing the stack name comes from.
      // Masked FIRST, then bounded: the mask must see the raw text it matches.
      const loggedKey = displayIdent(maskSecretsInText(producer.key, secrets));
      const loggedStack = displayStackName(maskSecretsInText(producer.stack, secrets));
      // The producer is not a stack of this app, so scrub has no template to
      // classify the export with — and no chain to follow out of it either.
      // Documented residual — see {@link producerPublishesSecretExpression}.
      if (!producerTemplates.has(producer.stack)) {
        logger.debug(
          `Scrub of ${shownStackName}: ${where} resolved through producer ${loggedStack} ` +
            `(${displayIdent(producer.region)}), which is not a stack of this app — scrub has no template to ` +
            `classify export ${loggedKey} with. Not classified as a plaintext producer.`
        );
        return;
      }
      const verdict = secretExpressionVerdict(producer.stack, producer.key);
      if (verdict.kind === 'no') {
        logger.debug(
          `Scrub of ${shownStackName}: ${where} resolved through producer ${loggedStack}, whose ` +
            `template declares no {{resolve:...}} expression for ${loggedKey} and no ` +
            `re-export chain reaching one. Not classified as a plaintext producer.`
        );
        return;
      }
      // THE DISCRIMINATOR: read the producer's STORED value and test IT.
      //
      // The RESOLVED value cannot answer this, and neither can the template.
      // `reresolveCrossStackValue` RESOLVES a stored expression to plaintext
      // before returning it (issue #1934's whole point), so the healthy case
      // (producer scrubbed, state holds the expression) and the broken one
      // (producer unscrubbed, state holds the plaintext) BOTH arrive here with
      // a plaintext in hand and both satisfy the template test. Three earlier
      // cuts each tried to INFER the difference from the consumer's side and
      // each was wrong in a different way: `carriesDynamicReference(resolved)`
      // was inverted, the template test was true of both, and the needle-count
      // test was wrong in BOTH directions — a COMPOSITE export keys the needle
      // by the embedded SUBSTRING while `resolved` is the whole URI (so
      // `secrets.has(resolved)` is false and a repeat reference refused a
      // healthy producer), a NON-STRING resolved value could not be tested at
      // all, and a needle recorded while resolving the reference's own ARGUMENT
      // satisfied the count and suppressed a refusal that should have fired.
      //
      // Since round 1 wired `stateBackend` into these contexts, the proposition
      // can be OBSERVED instead of inferred: the producer's stored value either
      // carries a `{{resolve:` expression or it does not. That is exact for a
      // composite value, for a non-string one, for the second reference to one
      // export, and for an argument that records needles of its own — and it
      // costs no extra AWS call, since the read below hits the same memoized
      // `getState` promise the resolution just used.
      //
      // This SUBSUMES the old `carriesDynamicReference(resolved)` fast path:
      // resolution never introduces an expression, so a resolved value carrying
      // one (a spelling cdkd resolves for nobody — since issue #2482 that is
      // no CloudFormation service, only text that merely looks like one)
      // implies the stored value carries one too, and this arm returns for it.
      const stored = await storedProducerValue(producer, context.stateBackend, nodeCanRefuse);
      // No readable producer record, or no such key in it — cannot classify, so
      // do not refuse. DELIBERATELY UNFENCED, and measured rather than assumed:
      // making this arm throw leaves all 60 tests in
      // `scrub-import-value-secret.test.ts` green, because every arm that
      // reaches here just read that record through the SAME memoized `getState`
      // promise and matched that very key. The one route that could reach it is
      // a stale exports INDEX (whose entry carries a value the producer's state
      // no longer has), and `scrubStack` deliberately supplies no `exportIndex`
      // — so writing a test for it would mean fabricating a state scrub cannot
      // produce. Kept as the fail-open guard for a future caller that does.
      if (!stored) {
        logger.debug(
          `Scrub of ${shownStackName}: ${where} resolved through producer ${loggedStack} ` +
            `(${displayIdent(producer.region)}), whose state record could not be read or does not carry the ` +
            `key ${loggedKey} — cannot classify, so this is not classified as a plaintext ` +
            `producer.`
        );
        return;
      }
      // The producer's state holds the EXPRESSION: it has been scrubbed, the
      // read handed this stack a resolvable secret, and there is nothing wrong.
      if (carriesDynamicReference(stored.stored)) {
        logger.debug(
          `Scrub of ${shownStackName}: ${where} resolved through producer ${loggedStack}, whose ` +
            `stored value for ${loggedKey} already carries a {{resolve:...}} expression — ` +
            `the producer is scrubbed and there is nothing wrong with this read.`
        );
        return;
      }
      // ...and neither is it a plaintext when it carries no text at ALL (issue
      // #2133 review). `carriesDynamicReference` is false for `null`, `''` and
      // every non-string scalar, so under a `widened` verdict — where the
      // producer merely has SOME secret-bearing output and this key matched no
      // declared one — a stored `null` or `''` raised
      // `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` claiming the read "resolved to a
      // PLAINTEXT value". That refusal is both false and UNCLEARABLE: scrubbing
      // the producer cannot turn an empty value into an expression, so the
      // re-run the message prescribes refuses identically forever.
      //
      // A resolved dynamic reference is always a STRING, so a non-string scalar
      // cannot be a legacy plaintext secret either, and an empty string holds
      // nothing to redact. Same fail-open shape as `!stored` above: cannot
      // classify, so do not refuse. CONTAINERS are deliberately NOT covered —
      // an array or object can nest a plaintext string, and `[]` / `{}` reach
      // this arm only through a producer that publishes an empty collection,
      // which no shape here can distinguish from a populated one worth testing.
      if (storedValueCarriesNoPlaintext(stored.stored)) {
        logger.debug(
          `Scrub of ${shownStackName}: ${where} resolved through producer ${loggedStack}, ` +
            `whose stored value for that key carries no ` +
            `text — nothing to redact, so this is not classified as a plaintext producer.`
        );
        return;
      }
      if (!nodeCanRefuse) {
        logger.debug(
          `Scrub of ${shownStackName}: ${where} resolved to a plaintext from unscrubbed ` +
            `producer ${loggedStack}, and this position cannot refuse.`
        );
        return;
      }
      throw plaintextProducerCrossStackReadError(
        origin.prose,
        stackName,
        key,
        path,
        producer.stack,
        producer.key,
        verdict,
        secrets
      );
    };

    const walk = async (v: unknown, path: string, nodeCanRefuse: boolean): Promise<void> => {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) await walk(v[i], `${path}[${i}]`, nodeCanRefuse);
        return;
      }
      if (v === null || typeof v !== 'object') return;
      const node = v as Record<string, unknown>;
      const key = effectiveIntrinsicKey(node);
      if (key === undefined) {
        for (const [k, val] of Object.entries(node)) {
          await walk(val, path ? `${path}.${k}` : k, nodeCanRefuse);
        }
        return;
      }
      if (key === 'Fn::If') {
        const args = node['Fn::If'];
        if (Array.isArray(args) && args.length === 3) {
          const [conditionName, ifTrue, ifFalse] = args as [unknown, unknown, unknown];
          const selected =
            typeof conditionName === 'string' && context.conditions?.[conditionName] === true
              ? ifTrue
              : ifFalse;
          await walk(selected, `${path}['Fn::If']`, nodeCanRefuse);
          return;
        }
        // Malformed: walk the args with refusals DISARMED. Falling through to
        // the plain object walk (the first cut's behaviour) let an unreadable
        // import in the UNTAKEN branch refuse the stack — the exact hazard the
        // selected-branch mirror exists to prevent.
        await walk(args, `${path}['Fn::If']`, false);
        return;
      }
      if ((CROSS_STACK_INTRINSIC_KEYS as readonly string[]).includes(key)) {
        await readOne(key, node, path, nodeCanRefuse);
        return;
      }
      // Some OTHER intrinsic wins this node, so the resolver resolves that
      // one's ARGUMENT and never looks at a sibling key. Descend into the
      // argument only — a cross-stack read nested inside an `Fn::Join` list is
      // one the main resolution reaches, unlike a read under a sibling key it
      // never dispatches on. Reaching it is not the same as performing it: an
      // earlier element of that same `Fn::Join` list can throw and abort the
      // rest, per the narrowed invariant on {@link makeCrossStackPrePass}.
      await walk(node[key], `${path}['${key}']`, nodeCanRefuse);
    };

    await walk(bag, '', canRefuse);
  };
}

/**
 * Bind every template parameter that carries a `Default`, each resolved ALONE
 * (issue [#2166](https://github.com/go-to-k/cdkd/issues/2166)).
 *
 * The fallback for a TOP-LEVEL stack whose whole-bag `resolveParameters`
 * failed: scrub takes no `--parameters`, so a `Default`-less parameter fails
 * that call, and before this every defaulted sibling was left unbound with it.
 * One call per parameter, through the same `resolveParameters`, so a binding
 * here is exactly what the whole-bag call would have produced for it; a
 * parameter whose own resolution fails stays unbound. A nested child never
 * reaches this: it refuses on the whole-bag failure instead.
 */
export async function bindDefaultedParametersOneByOne(
  resolver: IntrinsicFunctionResolver,
  template: CloudFormationTemplate,
  shownStack: string,
  logger: { debug: (message: string) => void }
): Promise<Record<string, unknown>> {
  const bound = nullPrototypeRecord<unknown>();
  const declared = template.Parameters;
  if (declared === undefined || declared === null || typeof declared !== 'object') return bound;
  for (const [name, definition] of Object.entries(declared)) {
    if (definition === null || typeof definition !== 'object' || !('Default' in definition)) {
      continue;
    }
    // An EMPTY `Default` stays unbound, as it did when the whole-bag call
    // failed: bound, `{{resolve:ssm-secure:${P}}}` assembles a NAMELESS
    // reference, which refuses the whole stack -- a refusal scrub's missing
    // `--parameters` would make unclearable.
    if ((definition as { Default?: unknown }).Default === '') continue;
    try {
      const one = await resolver.resolveParameters({
        ...template,
        Parameters: { [name]: definition },
      });
      if (Object.hasOwn(one, name)) bound[name] = one[name];
    } catch (err) {
      // No context and no bag here, so nothing to mask beyond the stack name
      // the caller already rendered; the parameter stays unbound.
      logger.debug(
        safeMsg`Parameter ${name} of ${shownStack} left unbound: ${describeAwsFailure(err).detail}`
      );
    }
  }
  return bound;
}
