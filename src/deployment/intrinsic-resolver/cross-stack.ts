import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../state/export-index-store.js';
import { importableOutputKeys } from '../../types/state.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../utils/ambient-client-defaults.js';
import {
  type ResolverContext,
  carriesDynamicReference,
  quotedRender,
  recordedSecretExpressions,
  withoutProducerRegions,
} from './support.js';
import {
  carriesSecretMask,
  crossStackSourceKey,
  isSecretExpressionByVerdictOrSpelling,
  isSingleDynamicReferenceToken,
  recordCrossStackExpression,
  recordFreshNoEchoValuesIn,
  recoverMaskedOutput,
} from '../secret-redaction.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    reresolveCrossStackValue: OmitThisParameter<typeof reresolveCrossStackValue>;
    /** @internal */
    pinSecretVerdict: OmitThisParameter<typeof pinSecretVerdict>;
    /** @internal */
    resolveImportValue: OmitThisParameter<typeof resolveImportValue>;
    /** @internal */
    recordImport: OmitThisParameter<typeof recordImport>;
  }
}

/**
 * Re-resolve the dynamic references in a value read out of a PRODUCER
 * stack's persisted outputs, before it is handed to the consumer (issue
 * [#1934](https://github.com/go-to-k/cdkd/issues/1934)).
 *
 * Since PR #1899 a secret-bearing output is stored REDACTED: `state.outputs`
 * and the exports index hold `{{resolve:secretsmanager:X:SecretString:pw}}`
 * rather than the resolved value. A consumer resolving `Fn::ImportValue` /
 * `Fn::GetStackOutput` got that string back VERBATIM and shipped the literal
 * token to AWS as the property value — the GHSA-p5qg-v9gv-hc7w class one
 * more time, and the same shape `resolveReplayProps` fixed for the rollback
 * replay and #1914 fixed for `cdkd drift --revert`. Every place that reads a
 * REDACTED bag and hands it onward has to re-resolve first; the cross-stack
 * import edge was the one that was missed, because the redaction and the
 * consumption live in different stacks and often different runs.
 *
 * `{{resolve:` re-resolution in {@link resolveValue} could not cover it: that
 * arm fires for a leaf INPUT string, and an intrinsic's RETURN value is never
 * fed back through it.
 *
 * WHICH REGION RESOLVES IT — the producer's, via {@link
 * resolverForProducerRegion}. The expression was resolved BY the producer IN
 * the producer's region, so that is the only region whose answer reproduces
 * the value the producer exported; a Secrets Manager secret or an SSM
 * parameter of the same NAME in two regions is two independent values (issue
 * #1933). The index hit carries `entry.producerRegion` (a required field) and
 * `Fn::GetStackOutput` carries the reference's own resolved `Region`, so both
 * of those are recorded rather than inferred.
 *
 * THE SCAN ARM IS THE EXCEPTION, and it is one this method inherits rather
 * than introduces: a pre-v2 state record has no `region` field, so the scan
 * reads it as `refRegion ?? this.resolverRegion` — the consumer's own region,
 * itself defaulted through `AWS_REGION` and then `us-east-1`. Where that
 * guess is wrong the re-resolution asks the wrong region and either misses
 * the secret (a hard failure naming the lookup, since issue #1934's
 * restructure surfaces it rather than degrading to `export not found`) or
 * resolves a same-named secret in the consumer's region. What bounds it is
 * that the guess is the SAME one the state READ just used, so this method
 * cannot disagree with the record it was handed — a region-less record was
 * already being read from that region or not found at all. The honest fix is
 * a region on the record, which is what schema v2 did for every record
 * written since.
 *
 * WHICH CREDENTIALS — the consumer's, which are the producer's too for every
 * path that reaches here. `Fn::ImportValue` reads the account-scoped state
 * bucket / exports index, so a producer it can see is in this account by
 * construction, and the cross-ACCOUNT `Fn::GetStackOutput` path deliberately
 * never calls this (see the refusal at its call site) rather than resolving a
 * producer's expression under the consumer's identity — which would answer
 * from a same-named secret in the WRONG account, the #1957 disclosure shape.
 *
 * The CONSUMER's `context` is passed through, which is what keeps the
 * consumer's own state redacted: each resolved plaintext is recorded into its
 * `recordedSecretValues`, so the deploy engine's save choke point rewrites it
 * back to the expression on the way into `state.json`. It also means
 * `skipDynamicReferences` is honoured, so the diff / no-op path keeps
 * comparing expression-vs-expression instead of fetching a secret to print.
 *
 * Identity-returns a value carrying no `{{resolve:` at all, so an ordinary
 * import is untouched.
 *
 * THE WALK BELOW IS A THIRD COPY, and that is recorded rather than fixed.
 * `rollback-executor/replay-props.ts`'s `resolveReplayProps` carries the same descent, and
 * `drift.ts`'s `resolveStateSecretExpressions` the same idea. Extracting one
 * helper is the right end state and is NOT this change's to make: the natural
 * home is beside those callers, in files a parallel lane owns, and a
 * cross-module extraction done from here would edit them. Two things a future
 * extractor needs that a mechanical merge would drop: this copy rebuilds
 * objects with `Object.create(null)` (the `__proto__` hazard below), and it
 * takes the RESOLVER as a parameter because the region it must answer for is
 * the producer's rather than the caller's — which is exactly what issue #2057
 * says the other two copies get wrong.
 */
/** @internal */
export async function reresolveCrossStackValue(
  this: IntrinsicFunctionResolver,
  value: unknown,
  producerRegion: string | undefined,
  context: ResolverContext,
  origin: string,
  sourceKey: string | undefined,
  producerOutput?: {
    stackName: string;
    region: string;
    outputKey: string;
    /**
     * Set when the read crosses an ACCOUNT boundary (a `RoleArn` on
     * `Fn::GetStackOutput`). Recovery is then REFUSED rather than served, and
     * that is a correctness fact rather than caution: the recovery store is
     * keyed by the AMBIENT credential identity (go-to-k/cdkd#3691) + stack +
     * region + output key -- the consumer's identity, never the RoleArn's --
     * and it only ever holds plaintexts THIS process masked while deploying
     * with those ambient credentials. So a same-named stack in the same region -- the
     * common shape for a `Shared` / `Network` stack replicated per account --
     * would serve the CONSUMER account's secret to a read that asked for the
     * PRODUCER account's, and the consumer would then send it to a resource
     * in the other account.
     *
     * The neighbouring `CrossAccountSecretRefusalError` refuses exactly this
     * confusion for a redacted DYNAMIC REFERENCE, and its reasoning ("a
     * same-named secret in the consumer account would answer instead")
     * transfers verbatim. It does not fire here only because
     * {@link SECRET_MASK} is not a dynamic reference, so that guard's
     * `carriesDynamicReference` test is false and this path falls through it.
     */
    crossAccount?: boolean;
  },
  /** The producer region's log text, when the caller transformed the region (issue #3150). */
  producerRegionLogText?: string
): Promise<unknown> {
  // Issue #2274: the CROSS-STACK twin of `noteAttributeSecrecy`, and it goes
  // HERE because this method is the one choke point every cross-stack read
  // returns through — `Fn::ImportValue` (both the index and the scan arms),
  // `Fn::GetStackOutput`, and a nested stack's `Outputs.<Key>`. A producer's
  // `state.outputs` entry can hold the mask (its own output resolved a
  // `NoEcho` custom resource's `Data`), and without this a CONSUMER stack
  // would push the literal `***` to AWS. It runs BEFORE the
  // `carriesDynamicReference` early return, because the mask is not a
  // dynamic reference and that return is exactly the path it takes.
  //
  // RECOVERY FIRST, refusal only when it fails. When the producer was
  // deployed by THIS process in THIS run, the plaintext behind the mask is
  // still in memory (`recoverMaskedOutput`) — which is the whole
  // `cdkd deploy --all` case, and the case a consumer template that deployed
  // fine before this feature lands on. Recovering it keeps the wire value
  // correct and re-registers it as a MASK-ONLY needle in the CONSUMER's own
  // bag, so the consumer's record still persists `***`. The refusal below is
  // then narrowed to what it is genuinely for: a producer deployed by an
  // EARLIER run, whose plaintext no longer exists anywhere cdkd can read.
  //
  // `origin` rather than a logical id: it is the caller-built description of
  // WHICH read this is (`Fn::ImportValue '<name>' (producer <stack> /
  // <region>)`), which is what a user needs to find the producer. It DOES
  // carry resolved values — every builder assembles it from an export /
  // output / stack name or a region, all of which this family masks elsewhere (`stack-output.ts` for the `Fn::GetStackOutput` origins) —
  // so it is masked at the push below. An earlier revision of this sentence
  // claimed the opposite and was refuted by grep (issue #2827 review).
  if (carriesSecretMask(value)) {
    const recovered =
      producerOutput === undefined || producerOutput.crossAccount === true
        ? undefined
        : recoverMaskedOutput(
            // The identity this resolution reads with (go-to-k/cdkd#3691).
            credentialFingerprint(ambientCredentialConfig()),
            producerOutput.stackName,
            producerOutput.region,
            producerOutput.outputKey
          );
    if (recovered !== undefined) {
      if (context.recordedSecretValues) {
        // FRESH (go-to-k/cdkd#3662): a value this process masked this run.
        // No producer record here, so only the regions and the stack names:
        // an echoed account id still flattens (fail-closed).
        const publicTokens = new Set(this.publicNoEchoTokens(context));
        if (producerOutput !== undefined) {
          publicTokens.add(producerOutput.stackName);
          publicTokens.add(producerOutput.region);
        }
        recordFreshNoEchoValuesIn(recovered, context.recordedSecretValues, undefined, publicTokens);
      }
      return recovered;
    }
    if (context.redactedAttributeReads !== undefined) {
      // MASKED AT THE PUSH (issue
      // [#2827](https://github.com/go-to-k/cdkd/issues/2827) review round 2),
      // which is one site instead of four: every caller assembles `origin`
      // from `attributeName` / `exportName` / `outputName` / `stackName` /
      // `region`, and this PR masks every one of those elsewhere. The comment
      // above used to assert `origin` "carries no resolved value"; that was
      // false, and the value travels — `DeployEngine.refuseRedactedAttributeReads`
      // joins this array into a throw at DEFAULT verbosity.
      //
      // Masked BEFORE the dedup, not after: the dedup compares `display`, so
      // a raw candidate would otherwise be compared against masked entries
      // and push a duplicate.
      //
      // NO `logicalId`, and that absence is the ROUTING FACT rather than a
      // missing field: this read resolved through ANOTHER stack, whose masked
      // record no `cdkd import` in this stack can reach. `maskedRecordRemedyFor`
      // reads the absence directly instead of inferring it from a spelling
      // that carries no dot.
      const loggedOrigin = this.displayMasked(origin, context);
      this.pushRedactedAttributeRead(context, {
        kind: 'cross-stack',
        display: loggedOrigin,
      });
    }
  }
  if (!carriesDynamicReference(value)) return value;

  const resolver = this.resolverForProducerRegion(producerRegion, context, producerRegionLogText);
  // The evidence must NOT reach a re-resolution whose ORIGIN IS ALREADY KNOWN
  // (issue #2134, rounds 1 and 2 of review). This method is handed the
  // producer it read the value out of, so when `producerRegion` is defined
  // the reference is attributed by construction -- consulting
  // `producerRegions` there can only re-open a question already answered, and
  // it verdicts `ambiguous` as soon as the consumer has two producers on
  // record.
  //
  // Gated on whether the producer region is KNOWN, rather than on whether a
  // SIBLING was built, which is what round 1 got wrong: a producer in the
  // consumer's OWN region yields `this`, so an identity test let the evidence
  // through and refused the local case while the cross-region one worked.
  // When the region really is unknown the evidence is KEPT -- the fail-closed
  // direction.
  //
  // TRUTHINESS, byte-for-byte the test `resolverForProducerRegion` itself
  // uses (`if (!producerRegion) return this;`). Round 3 caught the earlier
  // `!== undefined` as a SECOND SPELLING of one question, which is the same
  // recurrence rounds 1 and 2 were: the two disagree on `''`, and they
  // disagree on the fail-OPEN side -- the resolver treats `''` as unknown and
  // answers from the CONSUMER's region, while `!== undefined` called the
  // origin known and stripped the refusal's evidence.
  //
  // An empty region is reachable through the exports index, via EITHER of two
  // paths -- named separately because they are different code and an earlier
  // draft of this comment fused them: `loadIndex` parses the stored file with
  // an unchecked `JSON.parse`, so any `producerRegion` the file happens to
  // hold arrives verbatim; and `rebuild` writes `ref.region ?? this.region`,
  // where `??` passes an empty string through rather than replacing it. The
  // index-HIT arm hands that value straight to this method.
  const pinnedContext = producerRegion ? withoutProducerRegions(context) : context;
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string') {
      return v.includes('{{resolve:')
        ? await resolver.resolveDynamicReferences(v, pinnedContext)
        : v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length) as unknown[];
      for (let i = 0; i < v.length; i++) out[i] = await walk(v[i]);
      return out;
    }
    if (v !== null && typeof v === 'object') {
      // `Object.create(null)` rather than `{}`, matching `secret-redaction.ts`'s
      // `redactByPath` / `redactSecretsForState` (the #1943 class) so the
      // codebase carries ONE answer to this hazard. A JSON-parsed
      // `state.outputs` can hold an OWN key named `__proto__`; assigning it
      // onto a normal object literal neither creates the key nor keeps the
      // value — it walks the prototype setter, so the key VANISHES from the
      // rebuilt bag and the object's prototype changes with it. A null-
      // prototype object has no such setter, so the assignment is an ordinary
      // own-property write. Do not "simplify" this back to `{}`.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, val] of Object.entries(v)) out[k] = await walk(val);
      return out;
    }
    return v;
  };

  // Names the reference only — never the value, resolved or otherwise — and
  // MASKED (issue #2133 review). `origin` is assembled by the callers from
  // the RESOLVED `exportName` / `outputName` / `stackName`, each of which is
  // a `resolveValue` result and can therefore itself carry a resolved secret
  // (an export name built by an `Fn::Sub` over a `{{resolve:...}}` string).
  // Every other line naming those identifiers masks them; this one is the
  // sibling that did not.
  this.logger.debug(`Re-resolving dynamic reference(s) in ${this.displayMasked(origin, context)}`);
  const reresolved = await walk(value);

  // THE RECORDING SEAM for issue
  // [#2059](https://github.com/go-to-k/cdkd/issues/2059). This is the only
  // point in the process holding BOTH halves of the association the persist
  // path needs: the consumer's source LEAF (via `sourceKey`, computed by the
  // caller from the raw intrinsic with `crossStackSourceKey`) and the WHOLE
  // `{{resolve:...}}` token the producer stored. Without it a colliding pair
  // — an `:AWSCURRENT` and an `:AWSPREVIOUS` export of one secret, momentarily
  // equal during a rotation — collapses in the plaintext-keyed
  // `recordedSecretValues`, and `secret-redaction.ts` persists the SIBLING's
  // expression, which `resolveReplayProps` then applies to the live resource
  // on a rollback or a `cdkd drift --revert`.
  //
  // WHOLE-TOKEN ONLY. A producer value that merely EMBEDS a reference, or a
  // nested bag carrying one, has no single expression for the consumer's leaf,
  // and the persist path's condition 1 would refuse such a leaf anyway.
  //
  // GATED ON THIS EXPRESSION'S OWN SECRET VERDICT, which takes TWO tests
  // because neither is sufficient alone.
  //
  // `recordedSecretValues.has(reresolved)` says a secret with THIS PLAINTEXT
  // was resolved somewhere in the pass. It is deliberately a PRESENCE test —
  // the expression that key maps to may well be a SIBLING's, since that map is
  // exactly the one that collapsed — which is also why it cannot answer for
  // THIS token: the map is shared across the whole pass, so a PUBLIC
  // `{{resolve:ssm:/x}}` whose value happens to equal a secret already
  // recorded would pass it, and the public expression would then be persisted
  // in place of a resolved value. That is issue #1901's perpetual-UPDATE
  // class, and coinciding plaintexts are this issue's own premise rather than
  // a contrived path, so the presence test alone is not the gate this comment
  // used to claim it was.
  //
  // `isSecretExpressionByVerdictOrSpelling(value)` is the test that is
  // actually ABOUT this token: `secretsmanager` / `ssm-secure` by spelling,
  // or an `ssm` reference this process PROVED to be a `SecureString`. A plain
  // `String` parameter answers false — for the consumer's own region, where a
  // definitive public verdict RETRACTS a stale memo.
  //
  // NOT for a CROSS-REGION producer, and the exception belongs here rather
  // than being left to be rediscovered: `pinSecretVerdict` returns early for
  // a producer-region GUEST, so a guest's definitive `String` verdict never
  // retracts a `SecureString` memo the consumer's own resolver pinned for the
  // same spelling — and this then answers `true` for a producer-region
  // parameter that is really public. The cost is bounded to a spurious UPDATE
  // (#1901's class) and can never be a plaintext, since what gets persisted is
  // still an EXPRESSION. Closing it means keying the verdict store by region.
  //
  // Both, not either: presence proves the pass actually resolved this token to
  // a usable needle, the verdict proves the token is a secret at all.
  if (
    sourceKey !== undefined &&
    typeof value === 'string' &&
    isSingleDynamicReferenceToken(value) &&
    typeof reresolved === 'string' &&
    context.recordedSecretValues?.has(reresolved) === true &&
    isSecretExpressionByVerdictOrSpelling(value)
  ) {
    // Recorded INTO THIS PASS's own bag, which is what keeps two stacks that
    // spell the identical key (an `Fn::ImportValue` key carries no region)
    // from reading each other's associations at all. The plaintext beside the
    // expression then refuses a MISALIGNED entry inside the one pass.
    recordCrossStackExpression(context.recordedSecretValues, sourceKey, value, reresolved);
  }
  return reresolved;
}

/**
 * The resolver that must answer for a PRODUCER region — `this` when the
 * producer shares this resolver's own region, otherwise the pinned sibling
 * from {@link producerRegionResolvers}.
 *
 * The comparison is against {@link explicitRegion}, NOT {@link
 * resolverRegion}: the latter substitutes `AWS_REGION` and then a hard-coded
 * `us-east-1`, so comparing against it would answer "same region" on the
 * strength of a guess and resolve the producer's expression against whatever
 * the ambient clients happen to point at. When no region was named, a producer
 * region that IS named still binds — "unknown means SCOPE, not skip", the same
 * rule {@link clientsForRegion} applies, and the same one `Fn::GetAZs` already
 * follows for its template-named region.
 */
/**
 * Pin (or retract) a `{{resolve:...}}` secret verdict in the PROCESS-GLOBAL
 * store — unless this resolver is a producer-region GUEST, which writes
 * nothing there.
 *
 * The guest suppression is the correction the review of issue #1934 forced,
 * and the isolation note on {@link producerRegionResolvers} used to overstate
 * what a per-region resolver bought. The value cache is per-instance, but the
 * VERDICT store is not this class's — it lives in `secret-redaction.ts` and is
 * keyed by the expression STRING alone, so a producer-region resolution would
 * pin a FOREIGN region's answer for the whole process. The consequence is
 * concrete, and it lands on the consumer's very next pass: `isKnownSecret`
 * consults that store, and on the `skipDynamicReferences` (diff / no-op) path
 * a `true` verdict SKIPS the lookup and leaves the expression unresolved — so
 * a consumer-region parameter that is a plain `String`, and which state
 * therefore holds RESOLVED, would be compared as an expression and report a
 * spurious change on every run. That is issue #1901's perpetual-UPDATE class,
 * arriving through a region boundary the store cannot see.
 *
 * KEYING THE STORE BY REGION IS THE BETTER FIX AND IS NOT AVAILABLE FROM
 * HERE. `secret-redaction.ts` reads its own store internally with the BARE
 * expression (`isKnownSecretExpression`, and the mixed-leaf public-reference
 * test), so a region-qualified key would silently stop matching for the
 * redaction path — losing the #1910 losing-member arm and changing the #1926
 * empty-map verdict — and that file is owned by another lane in this run.
 * Suppressing the WRITE is the half that is correct on its own: it removes
 * the new cross-region reachability without changing the key, and the
 * consumer's own resolver keeps pinning its own region's verdicts exactly as
 * before.
 *
 * READS are deliberately NOT suppressed. A guest reading the consumer's
 * verdict can only seed `isKnownSecret`, which for `ssm` is OVERWRITTEN by
 * the fresh `GetParameter` response, and on the skip path it produces the
 * unresolved expression the diff wants anyway. Only the write direction
 * carried the defect.
 *
 * The cost of suppressing is one `GetParameter` per foreign expression per
 * later pass, since the guest's OWN instance cache still carries the verdict
 * alongside the value (issue #1933's design) and answers every repeat within
 * the deploy.
 */
export function pinSecretVerdict(
  this: IntrinsicFunctionResolver,
  expression: string,
  secret: boolean
): void {
  if (this.producerRegionGuest) return;
  if (secret) recordedSecretExpressions.add(expression);
  else recordedSecretExpressions.delete(expression);
}

/**
 * Resolve Fn::ImportValue (cross-stack references)
 *
 * Searches all other stacks for an exported output with the given name.
 */
export async function resolveImportValue(
  this: IntrinsicFunctionResolver,
  importValueArg: unknown,
  context: ResolverContext
): Promise<unknown> {
  // The canonical key for the issue #2059 association, computed from the RAW
  // argument rather than from the resolved `exportName` below. The persist
  // path holds the UNRESOLVED template leaf and nothing else, so the two keys
  // are byte-identical only when both are built from the same spelling by the
  // same function — and an export name that is itself an `Fn::Sub` / `Ref`
  // has no key at all, which is the refusal the redaction path falls back
  // from.
  const sourceKey = crossStackSourceKey({ 'Fn::ImportValue': importValueArg });

  // First, resolve the export name (it might contain intrinsic functions)
  const exportName = await this.resolveValue(importValueArg, context);

  if (typeof exportName !== 'string') {
    throw new Error(
      `Fn::ImportValue: export name must resolve to a string, got ${typeof exportName}`
    );
  }

  // Check if we have a state backend
  if (!context.stateBackend) {
    throw new Error('Fn::ImportValue: state backend is required for cross-stack references');
  }

  // MASKED, and the export NAME rather than only the value (issue #2133
  // review): `exportName` is the RESOLVED argument — `resolveValue` above
  // runs `Fn::Sub` / `Fn::Join` / a `{{resolve:...}}` string through — so an
  // export name assembled from a secret is a resolved secret in every line
  // that names it. Same treatment as `Fn::Join` / `Fn::Sub` already give
  // their results.
  const loggedExportName = this.displayMasked(exportName, context);
  this.logger.debug(`Resolving Fn::ImportValue: ${loggedExportName}`);

  // Hot path: consult the persistent exports index for O(1) lookup.
  // Skip self-references (a stack importing its own export) so the
  // fallback scan below can apply the same exclusion.
  if (context.exportIndex) {
    // The LOOKUP is what this catch degrades from — deliberately narrowed to
    // it (issue #1934). The re-resolution below can fail for real reasons
    // (an `AccessDenied` on `GetSecretValue`, a producer region that is not
    // client-safe), and inside this try those would have been swallowed as
    // "index lookup failed", re-scanned, found again, and finally reported
    // as `export not found in any stack` — an error naming neither the
    // cause nor the export that WAS found.
    let entry: Awaited<ReturnType<ExportIndexStore['lookup']>>;
    try {
      entry = await context.exportIndex.lookup(exportName);
    } catch (err) {
      this.logger.warn(
        // The CAUGHT MESSAGE is masked too since issue
        // [#2827](https://github.com/go-to-k/cdkd/issues/2827), and that half
        // is DEFENCE IN DEPTH rather than a closed leak — corrected in review
        // round 2, where an earlier revision of this comment claimed the
        // opposite. `ExportIndexStore.lookup` throws exactly twice, and both
        // messages name `indexKey()` (`<prefix>/_index/<region>/exports.json`)
        // or the index VERSION — never the export name, which is not a key
        // segment. So no reachable message here carries a plaintext today.
        // Kept for the same reason the `ListExports` twin below is: one
        // idempotent call, against re-deciding per future AWS error text.
        // What IS a closed leak is `loggedExportName` beside it (issue
        // #2133), and that is what the test for this site pins.
        `Exports index lookup failed for ${quotedRender(loggedExportName, "'", 'an export whose name is not a plain identifier')}: ` +
          `${this.displayMasked(err instanceof Error ? err.message : String(err), context)}` +
          `; falling back to state.json scan`
      );
      entry = undefined;
    }
    if (entry && (!context.stackName || entry.producerStack !== context.stackName)) {
      this.recordImport(context, exportName, entry.producerStack, entry.producerRegion);
      // NAMES the reference, never the VALUE (issue
      // [#2133](https://github.com/go-to-k/cdkd/issues/2133)). This line used
      // to interpolate `entry.value`, justified by "what the index holds for
      // a secret-bearing export is the `{{resolve:...}}` EXPRESSION". That
      // premise is true only of state a POST-#1934 binary wrote, and it is
      // false by construction for the population `cdkd scrub` exists for:
      // state an OLDER binary wrote, which holds the PLAINTEXT. Since scrub
      // gained a `stateBackend` (#2133) it reaches this line, `--dry-run`
      // included, and prints at DEFAULT verbosity. Masking could not rescue
      // it either — the needle for THIS value is recorded by the
      // re-resolution below, so at this point there is nothing to mask
      // against. The shape note keeps the one fact that made the value worth
      // logging (redacted vs literal) and discloses nothing.
      this.logger.info(
        `Resolved Fn::ImportValue: ${loggedExportName} (from index: ` +
          `${this.displayMasked(entry.producerStack, context)} / ${this.displayMasked(entry.producerRegion, context)}; ` +
          `${carriesDynamicReference(entry.value) ? 'redacted dynamic reference' : 'literal value'})`
      );
      return await this.reresolveCrossStackValue(
        entry.value,
        entry.producerRegion,
        context,
        `Fn::ImportValue ${quotedRender(this.displayLeaf(exportName, context), "'")} (producer ${this.displayLeaf(entry.producerStack, context)} / ${this.displayLeaf(entry.producerRegion, context)})`,
        sourceKey,
        // Issue #2274: the coordinate the value was READ from, so an in-run
        // producer's masked output can be recovered rather than refused. The
        // exports index is keyed by export name and `state.outputs` aliases
        // an exported output under that same name, so the export name IS the
        // output key here.
        {
          stackName: entry.producerStack,
          region: entry.producerRegion,
          outputKey: exportName,
        }
      );
    }
  }

  // Fallback path (index miss, drift, or no index supplied): scan every
  // stack's state.json. Same as the pre-index behavior.
  const allStacks = await context.stateBackend.listStacks();
  this.logger.debug(
    `Found ${allStacks.length} state record(s) to search for export: ${loggedExportName}`
  );

  // Hoisted out of the loop so the re-resolution happens OUTSIDE the
  // per-stack catch (issue #1934). Inside it, a failing `GetSecretValue`
  // would have been logged as `Failed to read state for stack X`, the scan
  // would have continued past the record it had just matched, and the caller
  // would have been told the export exists nowhere.
  let found: { value: unknown; refStack: string; lookupRegion: string } | undefined;

  for (const ref of allStacks) {
    const { stackName: refStack, region: refRegion } = ref;
    if (context.stackName && refStack === context.stackName) {
      this.logger.debug(`Skipping current stack: ${this.displayMasked(refStack, context)}`);
      continue;
    }

    try {
      const lookupRegion = refRegion ?? this.resolverRegion ?? '';
      if (!lookupRegion) {
        this.logger.debug(
          `No region available for stack ${quotedRender(this.displayMasked(refStack, context), "'")} — skipping (cdkd cannot read state without a region)`
        );
        continue;
      }
      const stateData = await context.stateBackend.getState(refStack, lookupRegion);
      if (!stateData) {
        this.logger.debug(
          `No state found for stack: ${this.displayMasked(refStack, context)} (${this.displayMasked(lookupRegion, context)})`
        );
        continue;
      }

      const { state } = stateData;

      // Through the shared predicate (issue #2193), not `in state.outputs`:
      // the bag also holds every plain Output name, and matching on those
      // bound an import to a stack that exports nothing of that name.
      if (importableOutputKeys(state).includes(exportName)) {
        // allow-template-keyed-bag-read: membership was just established by
        // `importableOutputKeys(state).includes(exportName)` above.
        const value = state.outputs[exportName];
        // No VALUE, for the reason the index arm above states (issue #2133).
        // This is the arm `cdkd scrub` actually takes, since scrub
        // deliberately supplies no `exportIndex`.
        this.logger.info(
          // `refStack` masked too (issue
          // [#2827](https://github.com/go-to-k/cdkd/issues/2827)'s sweep):
          // the export name has been masked here since #2133, and the stack
          // name beside it comes from a state scan, so it is a needle
          // whenever a producer stack is NAMED after a value this pass
          // resolved. Masking a non-needle is a no-op, so this costs
          // nothing on an ordinary stack.
          `Resolved Fn::ImportValue: ${loggedExportName} (from stack: ${this.displayMasked(refStack, context)} / ${this.displayMasked(lookupRegion, context)}; ` +
            `${carriesDynamicReference(value) ? 'redacted dynamic reference' : 'literal value'})`
        );
        // Patch the index with the just-discovered entry so subsequent
        // resolves hit the O(1) path. Best-effort — index write failures
        // are logged and don't fail the resolve.
        if (context.exportIndex) {
          context.exportIndex
            .patchEntry(exportName, {
              value,
              producerStack: refStack,
              producerRegion: lookupRegion,
            })
            .catch((err) => {
              this.logger.debug(
                // The FIFTH site of the class issue
                // [#2827](https://github.com/go-to-k/cdkd/issues/2827)
                // enumerates as four, found by sweeping the file rather than
                // the issue's list: same shape as the four warns, one level
                // quieter. An index write failure quotes the KEY it could
                // not write, which is built from the export name.
                `Failed to patch exports index for ` +
                  `${quotedRender(this.displayMasked(exportName, context), "'", 'an export whose name is not a plain identifier')}: ` +
                  `${this.displayMasked(err instanceof Error ? err.message : String(err), context)}`
              );
            });
        }
        this.recordImport(context, exportName, refStack, lookupRegion);
        found = { value, refStack, lookupRegion };
        break;
      }
    } catch (error) {
      this.logger.warn(
        // Both halves masked (issue
        // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): the sibling
        // of the index line above, and the one warn of the four that masked
        // NEITHER operand. `refStack` is a state-derived stack name and the
        // caught message quotes the state key it failed on.
        `Failed to read state for stack ${this.displayMasked(refStack, context)}: ` +
          `${this.displayMasked(error instanceof Error ? error.message : String(error), context)}`
      );
      continue;
    }
  }

  if (found) {
    // Same as the index arm above: the patched index entry carries the
    // STORED value; only what is handed to the consumer is re-resolved
    // (issue #1934). The log line above no longer carries any value at all
    // (issue #2133).
    return await this.reresolveCrossStackValue(
      found.value,
      found.lookupRegion,
      context,
      `Fn::ImportValue ${quotedRender(this.displayLeaf(exportName, context), "'")} (producer ${this.displayLeaf(found.refStack, context)} / ${this.displayLeaf(found.lookupRegion, context)})`,
      sourceKey,
      // Issue #2274 — see the index arm above. Same bag, reached by scanning
      // state instead of the index, so the same coordinate applies.
      { stackName: found.refStack, region: found.lookupRegion, outputKey: exportName }
    );
  }

  // CloudFormation fallback (issue #1697): the export is in no cdkd state
  // record — the producer may be a CloudFormation-managed stack (deployed
  // via `cdk deploy` / raw CFn). CloudFormation's own semantic for
  // Fn::ImportValue IS ListExports, so consult it before giving up.
  // cdkd-first precedence is inherent: this path only runs on a cdkd miss.
  // The resolution is deliberately NOT recorded into `recordedImports` —
  // `state.imports` drives destroy-time strong-ref protection, which cdkd
  // cannot honor for a producer it does not manage (and CFn's own
  // export-in-use protection cannot see cdkd consumers), so a CFn-sourced
  // import is a WEAK reference by design.
  if (this.cfnFallback) {
    const cfnExport = await this.lookupCfnExport(exportName, context);
    if (cfnExport) {
      // No VALUE (issue #2133). A CloudFormation export never passed through
      // cdkd's redaction, so what it holds is whatever the producer
      // published — a plaintext whenever the producer resolved one, which is
      // the same disclosure as the two arms above.
      // exporting STACK ID from the CloudFormation ListExports response, an
      // AWS-assigned ARN.
      // not-in-class(cfnExport.exportingStackId ? `; exporting stack: ${cfnExport.exportingStackId}` : ''): the exporting STACK ID from the CloudFormation ListExports response, an AWS-assigned ARN.
      this.logger.info(
        `Resolved Fn::ImportValue: ${loggedExportName} ` +
          `(from CloudFormation exports${
            cfnExport.exportingStackId ? `; exporting stack: ${cfnExport.exportingStackId}` : ''
          }; weak reference — producer is not cdkd-managed)`
      );
      // Deliberately NOT re-resolved (issue #1934). The re-resolution exists
      // to undo cdkd's OWN redaction, and this value never passed through it:
      // it is whatever CloudFormation holds for the export. CFn does not
      // resolve dynamic references in an export value either, so a
      // `{{resolve:...}}` here is a LITERAL the producer chose to publish, and
      // resolving it would diverge from what a CloudFormation consumer of the
      // same export receives.
      return cfnExport.value;
    }
  }

  // MASKED, for the reason `loggedExportName` above exists (issue #2133) and
  // now at the THROW too (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): the export name is
  // the RESOLVED argument, so an `Fn::Sub`-assembled name IS a decrypted
  // secret — and the throw is the copy that travels to every caller.
  throw new Error(
    `Fn::ImportValue: export ${quotedRender(loggedExportName, "'")} not found in any stack. ` +
      `Searched ${allStacks.length} cdkd state record(s)` +
      `${this.cfnFallback ? ' and CloudFormation exports' : ''}. ` +
      `Make sure the exporting stack has been deployed and the Output has an Export.Name property.`
  );
}

/**
 * Push a resolved `Fn::ImportValue` into the consumer's recorded-imports
 * bag (when supplied by the caller). Skips duplicates within the
 * SAME bag — multiple references to the same `(exportName,
 * sourceStack, sourceRegion)` triple emit one entry.
 *
 * Concurrency: the check + push pair is purely synchronous (no
 * `await` between `some()` and `push()`), so the JS event loop
 * cannot interleave a competing `recordImport` call between the
 * dedup check and the append. The bag's lifetime is per-deploy
 * (DeployEngine resets `this.recordedImports = []` at the top of
 * each `deploy()` call), so the bag identity already serves as
 * the dedup scope.
 *
 * Cross-context dedup: when callers share the same bag instance
 * across multiple ResolverContext objects (the typical pattern —
 * DeployEngine passes `this.recordedImports` into every resolver
 * context it constructs), the dedup naturally extends across
 * contexts because the `some()` reads the shared bag. Stashing
 * the dedup Set on `context.recordedImports` directly via a
 * property would break under `verbatimModuleSyntax`-style strict
 * typing; the array scan stays O(N) where N is the per-deploy
 * import count (typically < 20), which is fine.
 */
export function recordImport(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  exportName: string,
  producerStack: string,
  producerRegion: string
): void {
  if (!context.recordedImports) return;
  const dup = context.recordedImports.some(
    (e) =>
      e.exportName === exportName &&
      e.sourceStack === producerStack &&
      e.sourceRegion === producerRegion
  );
  if (dup) return;
  context.recordedImports.push({
    exportName,
    sourceStack: producerStack,
    sourceRegion: producerRegion,
  });
}
