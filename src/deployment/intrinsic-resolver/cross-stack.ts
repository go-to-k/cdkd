import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../state/export-index-store.js';
import { hasReadableOutputs } from '../../state/malformed-resources-bag.js';
import { injectiveKey } from '../../state/record-keys.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { importableOutputKeys } from '../../types/state.js';
import {
  ambientCredentialConfig,
  clientDefaultsFor,
  credentialFingerprint,
} from '../../utils/ambient-client-defaults.js';
import { awsClientDefaults } from '../../utils/aws-client-defaults.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { resolveCrossAccountStateBucket } from '../../utils/aws-region-resolver.js';
import {
  ROLE_ARN_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  displayAwsMessage,
  displayIdent,
  displaySafe,
  displayStackName,
} from '../../utils/display-safe.js';
import {
  CrossAccountSecretRefusalError,
  MalformedProducerRecordRefusalError,
} from '../../utils/error-handler.js';
import { UNSHOWABLE_VALUE, shellBoundedDisplay } from '../../utils/pasteable-command.js';
import { assumeRoleForCrossAccountStateRead, parseIamRoleArn } from '../../utils/role-arn.js';
import {
  MAX_LISTED_AVAILABLE_OUTPUTS,
  type NamedRequestMasks,
  type ResolverContext,
  carriesDynamicReference,
  clientCacheKey,
  isClientSafeRegion,
  quotedRender,
  recordedSecretExpressions,
  withoutProducerRegions,
} from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  SECRET_MASK,
  carriesSecretMask,
  crossStackSourceKey,
  hasMaskableValues,
  isSecretExpressionByVerdictOrSpelling,
  isSingleDynamicReferenceToken,
  maskSecretsInError,
  recordCrossStackExpression,
  recordFreshNoEchoValuesIn,
  recoverMaskedOutput,
  unionOfSecretBags,
} from '../secret-redaction.js';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListExportsCommand,
} from '@aws-sdk/client-cloudformation';
import { S3Client } from '@aws-sdk/client-s3';
import type { Export as CfnExport } from '@aws-sdk/client-cloudformation';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    reresolveCrossStackValue: OmitThisParameter<typeof reresolveCrossStackValue>;
    /** @internal */
    pinSecretVerdict: OmitThisParameter<typeof pinSecretVerdict>;
    /** @internal */
    resolveImportValue: OmitThisParameter<typeof resolveImportValue>;
    /** @internal */
    lookupCfnExport: OmitThisParameter<typeof lookupCfnExport>;
    /** @internal */
    describeAvailableOutputs: OmitThisParameter<typeof describeAvailableOutputs>;
    /** @internal */
    fetchAllCfnExports: OmitThisParameter<typeof fetchAllCfnExports>;
    /** @internal */
    lookupCfnStackOutputs: OmitThisParameter<typeof lookupCfnStackOutputs>;
    /** @internal */
    fetchCfnStackOutputs: OmitThisParameter<typeof fetchCfnStackOutputs>;
    /** @internal */
    getCfnClient: OmitThisParameter<typeof getCfnClient>;
    /** @internal */
    recordImport: OmitThisParameter<typeof recordImport>;
    /** @internal */
    resolveGetStackOutput: OmitThisParameter<typeof resolveGetStackOutput>;
    /** @internal */
    recordOutputRead: OmitThisParameter<typeof recordOutputRead>;
    /** @internal */
    positionalNameMask: OmitThisParameter<typeof positionalNameMask>;
    /** @internal */
    maskStateReadError(...args: Parameters<OmitThisParameter<typeof maskStateReadError>>): never;
    /** @internal */
    maskNamedError: OmitThisParameter<typeof maskNamedError>;
    /** @internal */
    namedRequestMasks: OmitThisParameter<typeof namedRequestMasks>;
    /** @internal */
    getSameAccountStackState: OmitThisParameter<typeof getSameAccountStackState>;
    /** @internal */
    getCrossAccountStackState: OmitThisParameter<typeof getCrossAccountStackState>;
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
 * `rollback-executor.ts`'s `resolveReplayProps` carries the same descent, and
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
  // output / stack name or a region, all of which this file masks elsewhere —
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
 * CloudFormation `ListExports` fallback lookup for `Fn::ImportValue`
 * (issue #1697). Searches the consumer's deploy region (CFn exports are
 * region-scoped, same as cdkd's `Fn::ImportValue` semantics).
 *
 * Returns `undefined` both when the export does not exist AND when the
 * lookup itself failed (a warning is logged for the latter — e.g. the
 * caller's credentials lack `cloudformation:ListExports`), so the caller
 * surfaces its own not-found error either way. Graceful degradation is
 * deliberate: without this fallback the deploy would have failed with
 * the same not-found error anyway.
 */
export async function lookupCfnExport(
  this: IntrinsicFunctionResolver,
  exportName: string,
  context?: ResolverContext
): Promise<{ value: string; exportingStackId?: string } | undefined> {
  // The SAME reading `fetchAllCfnExports` builds its client from: it reads
  // the ambient configuration synchronously, before its first `await`.
  const listingKey = credentialFingerprint(ambientCredentialConfig());
  let listing = this.cfnExportsPromises.get(listingKey);
  if (!listing) {
    const fetched = this.fetchAllCfnExports();
    listing = fetched;
    this.cfnExportsPromises.set(listingKey, fetched);
    // Do not cache failures: a transient throttle / permission fix should
    // be retried by the next lookup, not poison the whole deploy.
    fetched.catch(() => {
      if (this.cfnExportsPromises.get(listingKey) === fetched) {
        this.cfnExportsPromises.delete(listingKey);
      }
    });
  }
  try {
    const exports = await listing;
    for (const exp of exports) {
      if (exp.Name === exportName && exp.Value !== undefined) {
        return {
          value: exp.Value,
          ...(exp.ExportingStackId && { exportingStackId: exp.ExportingStackId }),
        };
      }
    }
    return undefined;
  } catch (error) {
    // not-in-class(this.resolverRegion): a REGION: operator-supplied (--region) or a state-record field.
    this.logger.warn(
      // MASKED for the reason `resolveImportValue`'s own lines are (issue
      // #2133 review), and this one prints at DEFAULT verbosity.
      `Fn::ImportValue: CloudFormation ListExports fallback failed for export ` +
        `${quotedRender(this.displayMasked(exportName, context), "'")} ` +
        // The caught message is masked too since issue #2827, and this is
        // the one site of the five where that half is DEFENCE IN DEPTH
        // rather than a closed leak — recorded rather than left for the next
        // reader to assume otherwise. `ListExportsCommand` takes only a
        // `NextToken`, so no template-derived value is in the request and
        // AWS has nothing to quote back; measured by mutation probe, where
        // removing this mask alone reds NOTHING while removing the export
        // name's mask beside it reds two cases. Its `DescribeStacks` twin
        // below is genuinely reachable (that call DOES carry a resolved
        // `StackName`, and an AccessDenied names the resource it refused),
        // so the two are spelled the same on purpose: a uniform pair is what
        // stops a future reader deciding this one may be dropped.
        `(region ${this.resolverRegion}): ` +
        `${this.displayMasked(error instanceof Error ? error.message : String(error), context)}. ` +
        `Grant cloudformation:ListExports to resolve exports from CloudFormation-managed stacks, ` +
        `or pass --no-cfn-fallback to disable the fallback.`
    );
    return undefined;
  }
}

/**
 * Render the `Available outputs: ...` tail of an `Fn::GetStackOutput`
 * not-found error (issue #2133 review).
 *
 * These are the PRODUCER's `state.outputs` / CloudFormation output KEYS, and
 * they land in a top-level ERROR — the one thing on this path that reaches a
 * CI log at default verbosity. A key can itself hold plaintext: that is the
 * `secretBearingStateKeyWarning` class (issue #1919), which `cdkd scrub`
 * counts and deliberately never prints, so the enumeration must not be the
 * one place that does.
 *
 * MASKED and CAPPED rather than dropped. Masking is the treatment every other
 * identifier on this path already gets, and the cap bounds what one error can
 * disclose (a producer with hundreds of outputs would otherwise dump all of
 * them). Dropping the names entirely was considered and rejected: a typo'd
 * `OutputName` is the overwhelmingly common cause, and the list is what makes
 * the error actionable.
 *
 * `maskSecretsRaw` reads the consumer pass's log twin first (issue #3150),
 * so a key equal to a name this pass assembled around a short secret is
 * masked. Residual, stated rather than hidden: the needles and twins belong to the
 * CONSUMER's resolution, so a plaintext sitting in a PRODUCER key that this
 * consumer never resolved is not maskable from here. The cap is what bounds that case;
 * `cdkd scrub` reporting the producer's own `secretBearingKeys` is the remedy.
 */
export function describeAvailableOutputs(
  this: IntrinsicFunctionResolver,
  keys: string[],
  context?: ResolverContext
): string {
  if (keys.length === 0) return '(none)';
  const shown = keys.slice(0, MAX_LISTED_AVAILABLE_OUTPUTS);
  // `displayMasked`, not the bare masker (go-to-k/cdkd#3408 round 3). These
  // keys are the PRODUCER's output names, read out of that stack's state
  // record — unchecked data — and this list is interpolated by its callers,
  // which is why the "never interpolate the masker" rule could not reach it:
  // the mask happens inside a map callback, one call away from the render.
  const rendered = shown.map((k) => this.displayMasked(k, context)).join(', ');
  const hidden = keys.length - shown.length;
  return hidden > 0 ? `${rendered} (+${hidden} more)` : rendered;
}

/** Full paginated ListExports walk backing {@link lookupCfnExport}'s memo. */
export async function fetchAllCfnExports(this: IntrinsicFunctionResolver): Promise<CfnExport[]> {
  const client = this.getCfnClient(this.resolverRegion);
  const exports: CfnExport[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListExportsCommand({ NextToken: nextToken }));
    exports.push(...(res.Exports ?? []));
    nextToken = res.NextToken;
  } while (nextToken);
  return exports;
}

/**
 * CloudFormation `DescribeStacks` fallback lookup for
 * `Fn::GetStackOutput` (issue #1697). Region-pinned because the
 * intrinsic may target a region different from the consumer's.
 *
 * Returns the stack's outputs map when the CFn stack exists;
 * `undefined` when it does not exist OR the lookup failed (a warning is
 * logged for non-not-found failures). Same graceful-degradation
 * contract as {@link lookupCfnExport}.
 */
export async function lookupCfnStackOutputs(
  this: IntrinsicFunctionResolver,
  stackName: string,
  region: string,
  context: ResolverContext | undefined,
  /** How `region` is printed: its caller's log text of the raw region (issue #3150). */
  loggedRegionText: string
): Promise<Record<string, string> | undefined> {
  // ENCODED, not separated (go-to-k/cdkd#3496). DEFENCE IN DEPTH, and the
  // bound is worth stating rather than leaving to be re-derived: `stackName`
  // is template text, but a 2-part collision needs the OTHER pair's FIRST
  // half to carry the separator, and that is `region`, which reaches here
  // only through `canonicalizeRegion` + `isClientSafeRegion` or as a constant
  // per resolver instance. So the collision is not reachable today. What it
  // would cost if that gate moved is the reason to encode anyway: this cache
  // serves a RESOLVED OUTPUT BAG, so a hit answers one stack's
  // `Fn::GetStackOutput` with another stack's outputs.
  // The credential half is the reading `fetchCfnStackOutputs` builds its
  // client from, before its first `await` (issue #3588).
  const cacheKey = injectiveKey(
    region,
    stackName,
    credentialFingerprint(ambientCredentialConfig())
  );
  let fetch = this.cfnStackOutputsCache.get(cacheKey);
  if (!fetch) {
    fetch = this.fetchCfnStackOutputs(stackName, region);
    this.cfnStackOutputsCache.set(cacheKey, fetch);
    // Do not cache lookup FAILURES (the definitive does-not-exist miss
    // resolves to undefined and IS cached — that answer is stable for
    // the deploy's lifetime).
    fetch.catch(() => {
      if (this.cfnStackOutputsCache.get(cacheKey) === fetch) {
        this.cfnStackOutputsCache.delete(cacheKey);
      }
    });
  }
  try {
    return await fetch;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Both halves are the spelling THIS line prints below, so the pair and
    // the rendering cannot disagree about what "masked" means. That is a
    // live constraint, not a tidiness one: go-to-k/cdkd#3408 round 2 moved
    // the two printed operands to `displayMasked` (which STRIPS as well as
    // masks) and left these pairs on the bare masker, so the same name could
    // render two ways in one message — bare in the AWS echo this rewrites,
    // stripped where we print it ourselves. go-to-k/cdkd#3426 removed that
    // second spelling from the file entirely. The pairs' replacement is the
    // PRE-BOUNDARY masked spelling (the line below bounds it further through
    // `displayMaskedIdent`), as at `maskStateReadError`'s call site: it
    // rewrites text another module rendered, where a second boundary would
    // only nest quotes.
    const cfnNameMask = this.positionalNameMask([
      [stackName, this.displayMasked(stackName, context)],
      [region, this.displayMasked(loggedRegionText, context)],
    ]);
    this.logger.warn(
      // MASKED, the exact twin of `lookupCfnExport`'s own line (issue #2133
      // review), and this one prints at DEFAULT verbosity too. `stackName`
      // reaches here from `resolveGetStackOutput`'s `resolveValue` result, so
      // a stack name assembled from a `{{resolve:...}}` reference is a
      // resolved secret in every line that names it. The method took no
      // `context` at all until now, which is why it was the one sibling with
      // nothing to mask against; its only caller has one.
      `Fn::GetStackOutput: CloudFormation DescribeStacks fallback failed for stack ` +
        // `message` masked too since issue #2827 — `DescribeStacks` quotes
        // the stack name back, and `region` is itself a resolved value.
        //
        // The AWS text goes through the POSITIONAL pass first (issue #3234):
        // this frame hands `stackName` to `DescribeStacks` raw, and
        // `displayMasked` over the returned sentence finds no twin for it
        // and falls to the needle pass, whose substring arm cannot see a
        // sub-floor secret assembled into the name. Same class, reached from
        // the same caller as the state read below (this is its own method,
        // not the same frame); the two share `positionalNameMask`.
        // STRIPPED as well as masked, since go-to-k/cdkd#3408 round 2 —
        // and this is the site that made the round-1 repair ONE-SIDED. That
        // repair hardened `resolveGetStackOutput`'s four THROWS and left this
        // warn, which is worse in two ways: `cfnFallback` DEFAULTS TO TRUE,
        // so this is the ordinary path rather than an opt-in one, and `warn`
        // prints at DEFAULT verbosity where a throw at least accompanies a
        // failure. Measured emitting a live `ESC[2K` + CR from a hostile
        // `StackName`.
        `${this.displayMaskedIdent(stackName, context, STACK_REF_MAX_CODE_POINTS)} ` +
        `(${this.displayMaskedIdent(loggedRegionText, context)}): ` +
        // The AWS text is BOUNDED as well: `DescribeStacks` quotes the
        // submitted stack name back, so its length is the template author's
        // choice — the same reason `role-arn.ts` bounds STS's reply.
        `${displayAwsMessage(this.displayMasked(cfnNameMask ? cfnNameMask(message) : message, context))}. ` +
        `Grant cloudformation:DescribeStacks to resolve outputs from CloudFormation-managed ` +
        `stacks, or pass --no-cfn-fallback to disable the fallback.`
    );
    return undefined;
  }
}

/**
 * Single DescribeStacks read backing {@link lookupCfnStackOutputs}'s memo.
 * Resolves to the outputs map, `undefined` for the definitive
 * does-not-exist miss, and REJECTS on any other failure.
 */
export async function fetchCfnStackOutputs(
  this: IntrinsicFunctionResolver,
  stackName: string,
  region: string
): Promise<Record<string, string> | undefined> {
  try {
    const client = this.getCfnClient(region);
    const res = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = res.Stacks?.[0];
    if (!stack) return undefined;
    const outputs: Record<string, string> = {};
    for (const out of stack.Outputs ?? []) {
      if (out.OutputKey && out.OutputValue !== undefined) {
        // allow-template-keyed-bag-read: `OutputKey` is a CloudFormation output
        // LOGICAL ID, which CFn constrains to alphanumerics -- so it cannot be
        // `__proto__` and the write never reaches the inherited setter. (It IS
        // template text, the producer stack's; the constraint is what makes it
        // safe, not the provenance.)
        outputs[out.OutputKey] = out.OutputValue;
      }
    }
    return outputs;
  } catch (error) {
    // DescribeStacks signals "no such stack" via a ValidationError whose
    // message is `Stack with id <name> does not exist` — the expected
    // miss, not a lookup failure worth a warning. Require the TYPED name
    // alongside the message heuristic (issue #1697 review; memory rule
    // `feedback_predelete_steps_vs_notfound_heuristics`): a credentials /
    // assume-role error that happens to contain the phrase must surface
    // as a lookup failure (warn + retry-able), never as a silent miss.
    if (
      error instanceof Error &&
      error.name === 'ValidationError' &&
      /does not exist/i.test(error.message)
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Lazily-constructed per-region CloudFormation client (issue #1697).
 *
 * Built with the ambient clients' {@link AwsClients.credentialConfig}, the
 * way {@link serviceDiscoveryClient} is (issue
 * [#1983](https://github.com/go-to-k/cdkd/issues/1983)). An explicit
 * `AwsClientConfig.credentials` has no environment path — only a LIBRARY
 * caller passes one, and it never runs the CLI's `AWS_PROFILE` mirror — so a
 * client built from `awsClientDefaults()` alone ran the CFn fallback reads
 * under the default chain's identity instead. The explicit `credentials`
 * spread AFTER the defaults, so they outrank an assumed `--role-arn` role,
 * matching {@link AwsClients}' own spread order.
 *
 * Not routed through {@link clientsForRegion}: the region here is always
 * the one the caller named, never the ambient's, and a test double without
 * `credentialConfig` degrades to the default chain rather than throwing.
 * Keyed by region AND credential fingerprint for the reason
 * {@link regionScopedClients} gives (issue #3588).
 */
export function getCfnClient(
  this: IntrinsicFunctionResolver,
  region: string
): CloudFormationClient {
  const credentialConfig = ambientCredentialConfig();
  const key = clientCacheKey(region, credentialConfig);
  let client = this.cfnClients.get(key);
  if (!client) {
    client = new CloudFormationClient({ ...clientDefaultsFor(credentialConfig), region });
    this.cfnClients.set(key, client);
  }
  return client;
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

/**
 * Resolve Fn::GetStackOutput (cross-stack / cross-region / cross-account
 * output reference).
 *
 * Shape: { "Fn::GetStackOutput": { "StackName": "...", "OutputName": "...",
 *                                   "Region": "...", "RoleArn": "..." } }
 *
 * Unlike Fn::ImportValue, the producer stack is named explicitly and no
 * Export is required. cdkd reads the producer's `outputs` from the
 * region-scoped state record at
 * `s3://{bucket}/cdkd/{StackName}/{Region}/state.json`. When `Region` is
 * omitted, the consumer's deploy region is used.
 *
 * **RoleArn (cross-account)**: when set, cdkd issues `sts:AssumeRole`
 * against the supplied role and reads the PRODUCER ACCOUNT's separate
 * cdkd state bucket (`cdkd-state-{producerAccountId}`) — bucket name
 * derived from the role ARN's account ID and the canonical
 * region-free bucket convention. The assumed credentials are cached
 * per-RoleArn for the deploy lifetime so a stack that references the
 * same producer multiple times only pays one STS hop. **The inline
 * `RoleArn` argument is constrained to literal strings only** — no
 * `Ref` / `Fn::GetAtt` / `Fn::Sub` chains — because the resolver
 * context isn't guaranteed to have the producer-account info available
 * at intrinsic-resolution time and a typo'd role lookup is far worse
 * than a clear "literal-string required" error at template-author
 * time. Same-account references (no RoleArn) take the original
 * shared-state-backend path.
 */
export async function resolveGetStackOutput(
  this: IntrinsicFunctionResolver,
  arg: unknown,
  context: ResolverContext
): Promise<unknown> {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    throw new Error(
      `Fn::GetStackOutput: argument must be an object with StackName/OutputName/Region/RoleArn, got ${
        arg === null ? 'null' : Array.isArray(arg) ? 'array' : typeof arg
      }`
    );
  }
  const args = arg as Record<string, unknown>;

  if (!('StackName' in args)) {
    throw new Error('Fn::GetStackOutput: StackName is required');
  }
  if (!('OutputName' in args)) {
    throw new Error('Fn::GetStackOutput: OutputName is required');
  }

  // Same as `Fn::ImportValue`'s: built from the RAW args, so the persist
  // path's key over the unresolved template leaf is the same string (issue
  // #2059). A non-literal `StackName` / `OutputName` / `Region` / `RoleArn`
  // yields no key, and the redaction path then falls back to today's
  // behaviour rather than guessing.
  const sourceKey = crossStackSourceKey({ 'Fn::GetStackOutput': args });

  const stackName = await this.resolveValue(args['StackName'], context);
  if (typeof stackName !== 'string' || stackName === '') {
    throw new Error(
      `Fn::GetStackOutput: StackName must resolve to a non-empty string, got ${typeof stackName}`
    );
  }

  const outputName = await this.resolveValue(args['OutputName'], context);
  if (typeof outputName !== 'string' || outputName === '') {
    throw new Error(
      `Fn::GetStackOutput: OutputName must resolve to a non-empty string, got ${typeof outputName}`
    );
  }

  let region = this.resolverRegion;
  // The spelling every line below prints `region` with (issue #3150): the
  // log text of the resolver's own region, which a string this pass
  // assembled can equal, or of a template-supplied region's RAW value, since
  // `canonicalizeRegion` lowercases it past any twin lookup.
  let loggedRegionText = this.logTextOfLeaf(region, context);
  if ('Region' in args && args['Region'] !== undefined && args['Region'] !== null) {
    const resolvedRegion = await this.resolveValue(args['Region'], context);
    if (typeof resolvedRegion !== 'string' || resolvedRegion === '') {
      throw new Error(
        `Fn::GetStackOutput: Region must resolve to a non-empty string, got ${typeof resolvedRegion}`
      );
    }
    // Region-shape gate (issue #1957 review). This value is TEMPLATE-derived
    // — `{"Region": {"Ref": "SomeParam"}}` resolves through `resolveValue`
    // above — and it reaches TWO sinks that both treat it as trusted:
    //
    //   1. an SDK client region, via `lookupCfnStackOutputs` ->
    //      `getCfnClient(region)` -> `new CloudFormationClient({ region })`.
    //      A region is substituted into the service hostname, so
    //      `evil.example.com#` yields a SigV4-SIGNED `DescribeStacks` to
    //      `https://cloudformation.evil.example.com/#.amazonaws.com`.
    //   2. an S3 STATE-KEY segment, via `getState(stackName, region)` ->
    //      `cdkd/{stack}/{region}/state.json`. A `../` there traverses within
    //      the state bucket and reads a key the template never named.
    //
    // Older than this PR — the client has always been built from it — but the
    // gate is one call away and the sink list is exactly this PR's subject,
    // so it is closed here. THROW rather than fall back to the resolver's own
    // region, for the same reason as `Fn::GetAZs` and one more: silently
    // substituting a different region would read ANOTHER region's stack
    // outputs and hand them to the consumer as if they were the requested
    // ones. The CANONICAL form is what flows onward, so the client and the
    // state key agree on one spelling.
    const requestedRegion = canonicalizeRegion(resolvedRegion);
    if (!isClientSafeRegion(requestedRegion)) {
      // MASKED BEFORE THE TRANSFORM, the exact twin of `Fn::GetAZs`' region
      // gate — see the comment there for why the order is load-bearing
      // (issue [#2827](https://github.com/go-to-k/cdkd/issues/2827)).
      throw new Error(
        `Fn::GetStackOutput: ${this.displayMaskedIdent(this.logTextOfLeaf(resolvedRegion, context) !== resolvedRegion ? SECRET_MASK : resolvedRegion, context, 64)} is not a ` +
          `valid AWS region name. The region selects both the AWS endpoint and the state-file ` +
          `key, so cdkd will not use it.`
      );
    }
    region = requestedRegion;
    loggedRegionText = this.regionLogText(resolvedRegion, context);
  }

  // RoleArn must be a LITERAL string in the template — we check the raw
  // value rather than running it through resolveValue, because a Ref /
  // Fn::GetAtt / Fn::Sub chain would either silently resolve to the
  // wrong principal or quietly fail in a way that masks the
  // cross-account intent. The error message is specific so template
  // authors know to inline the ARN.
  let roleArn: string | undefined;
  if ('RoleArn' in args && args['RoleArn'] !== undefined && args['RoleArn'] !== null) {
    const raw = args['RoleArn'];
    if (typeof raw !== 'string' || raw === '') {
      // The shape through the builder (issue #3441), for the reason the
      // `Invalid Fn::GetAtt format` echo takes it: being pre-resolution
      // answers the secret question, not the control-character one, and
      // `JSON.stringify` escapes C0 controls but passes `U+2028` / `U+2029`
      // and the bidi overrides through as written.
      throw new Error(
        `Fn::GetStackOutput: RoleArn must be a literal string in the template ` +
          `(no Ref / Fn::GetAtt / Fn::Sub allowed for cross-account references). ` +
          `Got ${
            raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
          }${typeof raw === 'object' ? ` (intrinsic shape: ${this.displayMasked(JSON.stringify(raw).slice(0, 80), context)})` : ''}.`
      );
    }
    roleArn = raw;
  }

  // Reject obvious self-reference (same stack AND same region AND
  // same account — we cannot detect the account-id mismatch without
  // STS, so we only enforce same-region same-stack here; the
  // cross-account RoleArn case is by definition NOT self-reference).
  if (
    !roleArn &&
    context.stackName &&
    context.stackName === stackName &&
    // BOTH sides folded AT THE COMPARISON, which is the only place that can
    // be done without moving a state key.
    //
    // `region` enters this method by two paths with different spellings:
    // folded when the template names a `Region` (`canonicalizeRegion`, issue
    // #1957), RAW when it does not, since it then defaults to
    // `this.resolverRegion`. On the no-`Region` path both sides were the same
    // raw string before issue #1882 folded `AWS::Region`, so it compared a
    // value to itself and always fired; on the named-`Region` path they have
    // been folded-against-raw since issue #1957, which is the pre-existing
    // half of the miss. Folding only ONE side repairs the first path
    // and breaks the second — measured on this branch, where a mis-cased
    // resolver region with no `Region` argument resolved its OWN stack's
    // output instead of refusing, and `cfnFallback` defaults to true, so the
    // read can land on a same-named CloudFormation stack.
    //
    // Do not fold either operand at its DEFINITION. `region` is passed on to
    // `getSameAccountStackState` / `getCrossAccountStackState` /
    // `lookupCfnStackOutputs`, where it is a state-key segment, and
    // `this.resolverRegion` keys this stack's own `getState` / `saveState`.
    // Normalizing only for the duration of the comparison leaves both.
    canonicalizeRegion(region) === canonicalizeRegion(this.resolverRegion)
  ) {
    // MASKED at the throw (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). This refusal
    // fires BEFORE `loggedStackName` is bound a few lines down, so it masks
    // its own raw values; `region` is masked too — `isClientSafeRegion` is
    // `/^[a-z0-9][a-z0-9-]{0,30}$/`, wide enough for a real plaintext to
    // pass it.
    // Stripped too (go-to-k/cdkd#3408 round 2). It fires BEFORE
    // `loggedStackName` is bound, so it cannot reuse that binding — but it
    // renders the SAME value class, and the comment above arguing that
    // masking suffices is what the round-1 measurement disproved.
    throw new Error(
      `Fn::GetStackOutput: cannot reference own stack ` +
        `${this.displayMaskedIdent(stackName, context, STACK_REF_MAX_CODE_POINTS)} in the same region ` +
        `${this.displayMaskedIdent(loggedRegionText, context)}`
    );
  }

  // MASKED, same reason as `Fn::ImportValue`'s export name (issue #2133
  // review): both `StackName` and `OutputName` come back from `resolveValue`,
  // so either can carry a resolved secret.
  // STRIPPED as well as masked, since issue
  // [#3397](https://github.com/go-to-k/cdkd/issues/3397). `maskSecretsRaw`
  // answers "does this text contain a recorded secret"; it makes no claim
  // about CONTROL CHARACTERS, and both of these are template-derived through
  // `resolveValue` with only a non-empty-string gate in front of them. So the
  // lines below rendered a `StackName` carrying `ESC[2K` + CR raw — measured
  // on this very throw during go-to-k/cdkd#3408's security review, which
  // emitted a line that erases and rewrites itself.
  //
  // That is the SAME defect this issue is about, one operand to the left: the
  // `RoleArn` on these lines is sanitized and its neighbour was not, which is
  // exactly what `local-profile-display-population.test.ts`'s mixed-render arm
  // exists to catch and cannot see here (this whole directory is outside
  // `inMixedScope`; go-to-k/cdkd#3405 owns that widening).
  //
  // NOTE TO AN EDITOR OF THIS COMMENT: never write a slash followed by two
  // stars anywhere in this file outside a real doc comment — a directory glob
  // is the way it happens. Several source-shape fences over this file strip
  // block comments with a non-greedy regex pass, and that sequence OPENS one
  // even inside a line comment, so everything up to the next close-marker
  // vanishes from what the fence reads. Measured twice while writing this
  // very paragraph (go-to-k/cdkd#3408): the first spelling swallowed the
  // `hasReadableOutputs(` anchor 150 lines down and reported the
  // malformed-producer refusal as deleted; the second was this warning
  // quoting the sequence it warns about.
  //
  // `maskThenStripThenMask` rather than a bare `stripControlChars` is the
  // rule this file already settled seven sites up: stripping DELETES, so a
  // plaintext split by an invisible would be reconstituted contiguous by a
  // strip applied after a single mask. Masking on both sides of it closes
  // that, and it is a no-op on any ordinary name.
  const loggedStackName = this.displayMaskedIdent(stackName, context, STACK_REF_MAX_CODE_POINTS);
  const loggedOutputName = this.displayMaskedIdent(outputName, context);
  // The THIRD resolved value of this trio (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): a `Region`
  // argument also comes back from `resolveValue`, and the shape gate above
  // only proves it is `[a-z0-9-]{1,31}` — a real plaintext can be. Bound
  // here so the log lines and the three throws below share ONE masked
  // spelling instead of each deciding.
  const loggedRegion = this.displayMasked(loggedRegionText, context);
  // The FOURTH value of this group, and the one that needed a different
  // helper (issue
  // [#3397](https://github.com/go-to-k/cdkd/issues/3397)). `roleArn` is NOT a
  // resolved value — the notes below say so, and that is a statement about
  // MASKING. It is still a LITERAL the user wrote in their own template,
  // reaching a terminal with no shape gate between: the `parseIamRoleArn`
  // check that would reject a malformed one runs later, in
  // `getCrossAccountStackState`, and only on the cross-account branch. So the
  // three lines below and the refusal there used to render argv-grade text
  // raw, which is the class issue
  // [#2170](https://github.com/go-to-k/cdkd/issues/2170) closed for
  // `src/utils/role-arn.ts` and issue
  // [#3390](https://github.com/go-to-k/cdkd/issues/3390) closed for the
  // `cdkd local` surface.
  //
  // Bound ONCE, for the reason `loggedRegion` above is: four renders sharing
  // one spelling cannot drift into three. `displayIdent` rather than
  // `displaySafe` because an ARN is an IDENTIFIER — a positive allowlist plus
  // a length cap, and a JSON-quoted boundary the moment the value is not one.
  // A COMMON ARN's characters are all in `PLAIN_IDENT`, so an ordinary value
  // renders byte-identically and no fixture's grep moves. NOT "every
  // legitimate ARN" -- IAM paths admit `( ) ! # $ % & * [ ]`, which render
  // JSON-quoted; `src/utils/role-arn.ts` carries that cost note in full.
  const shownRoleArn = roleArn
    ? displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })
    : '';
  // not-in-class(roleArn ? `, RoleArn=${shownRoleArn}` : ''): the RoleArn argument, refused unless it is a literal template string.
  this.logger.debug(
    `Resolving Fn::GetStackOutput: StackName=${loggedStackName}, Region=${loggedRegion}, ` +
      `OutputName=${loggedOutputName}${roleArn ? `, RoleArn=${shownRoleArn}` : ''}`
  );

  // Cross-account branch: assume the role, derive the producer's
  // state bucket from the role ARN's account ID, build an ephemeral
  // S3StateBackend pointed at it with the assumed credentials, then
  // read the producer's state.
  //
  // MASKED AT THIS BOUNDARY (issue
  // [#3234](https://github.com/go-to-k/cdkd/issues/3234)), and it has to be
  // HERE rather than at the throw: the reads take the RAW `stackName` and
  // `region` because those are state-KEY segments, and `S3StateBackend` — a
  // module that holds no secrets bag — quotes them back through
  // `displaySafe`, an ASCII sanitizer rather than a masker. This frame is the
  // last one holding both the raw names and their masked spellings, so it is
  // the only place the substitution can be exact.
  //
  // The `Fn::ImportValue` sibling catches its own read, but masks the caught
  // message with the BAGS alone (`displayMasked` over a composed AWS
  // sentence finds no twin and falls to the needle pass). That closes the
  // 4+ character class there and leaves the POSITIONAL half open — the same
  // gap in the same shape. Do not read it as the pattern this site is
  // catching up to.
  let stateData: Awaited<ReturnType<S3StateBackend['getState']>>;
  try {
    stateData = roleArn
      ? await this.getCrossAccountStackState(roleArn, stackName, region, context)
      : await this.getSameAccountStackState(stackName, region, context);
  } catch (error) {
    this.maskStateReadError(
      error,
      [
        // The pair's replacement is the MASKED spelling, not the bounded
        // one: it rewrites the name inside text another module already
        // rendered, where a second boundary would only nest quotes.
        [stackName, this.displayMasked(stackName, context)],
        [region, loggedRegion],
      ],
      context
    );
  }
  if (!stateData) {
    // CloudFormation fallback (issue #1697): the producer may be a
    // CloudFormation-managed stack (deployed via `cdk deploy` / raw CFn)
    // whose outputs live in CloudFormation, not cdkd state. Same-account
    // only — the RoleArn (cross-account) path keeps reading cdkd state
    // exclusively (a cross-account CFn read would need a different
    // permission model; see the issue's out-of-scope note).
    if (!roleArn && this.cfnFallback) {
      const cfnOutputs = await this.lookupCfnStackOutputs(
        stackName,
        region,
        context,
        loggedRegionText
      );
      if (cfnOutputs) {
        // `Object.hasOwn` (issue #2767): `outputName` is template-controlled and
        // `cfnOutputs` is built from an AWS response, so a bare `in` let
        // `OutputName: "constructor"` past this refusal and returned the function.
        if (!Object.hasOwn(cfnOutputs, outputName)) {
          const available = this.describeAvailableOutputs(Object.keys(cfnOutputs), context);
          // not-in-class(available): already rendered through describeAvailableOutputs, which masks each key.
          throw new Error(
            `Fn::GetStackOutput: output ${loggedOutputName} not found in CloudFormation stack ` +
              `${loggedStackName} (${displayIdent(loggedRegion)}). Available outputs: ${available}`
          );
        }
        const value = cfnOutputs[outputName];
        // No VALUE (issue #2133), same reason as the `Fn::ImportValue`
        // CloudFormation fallback: a CFn stack output never passed through
        // cdkd's redaction, so it is whatever the producer resolved.
        this.logger.info(
          `Resolved Fn::GetStackOutput: StackName=${loggedStackName}, Region=${loggedRegion}, ` +
            `OutputName=${loggedOutputName} ` +
            `(from CloudFormation stack outputs; weak reference — producer is not cdkd-managed)`
        );
        // Deliberately NOT recorded into `recordedOutputReads` —
        // `state.outputReads` names cdkd-managed producers so recreate
        // warnings can list downstream consumers; a CFn-managed producer
        // is never recreated by cdkd. And deliberately NOT re-resolved, for
        // the same reason as the `Fn::ImportValue` CloudFormation fallback
        // (issue #1934): this value never passed through cdkd's redaction.
        return value;
      }
    }
    // `roleArn`, which this method refuses unless it is a literal template
    // string, so it carries no resolved value.
    // cdkd-arn-display: the SECOND substitution of this statement
    // (`!roleArn && this.cfnFallback ? … : …`) mentions `roleArn` as a
    // TRUTHINESS TEST and renders neither arm from it -- both arms are
    // constant sentences. The value that IS rendered here is `shownRoleArn`,
    // one substitution up. Annotated rather than restructured because the
    // condition is the right code; the display fence keys on a name appearing
    // in a substitution and cannot tell a test from a render.
    // not-in-class(roleArn ? ` (cross-account via ${shownRoleArn})` : ''): the RoleArn argument, refused unless it is a literal template string.
    throw new Error(
      `Fn::GetStackOutput: stack ${loggedStackName} not found in region ${displayIdent(loggedRegion)}${
        roleArn ? ` (cross-account via ${shownRoleArn})` : ''
      }. ${
        !roleArn && this.cfnFallback
          ? `Searched cdkd state and CloudFormation stacks. Make sure the producer stack ` +
            `has been deployed (via cdkd or CloudFormation).`
          : `Make sure the producer stack has been deployed via cdkd.`
      }`
    );
  }

  // The producer's record is UNCHECKED data — `parseStateBody` validates the
  // root object and the schema version and nothing inside — so `outputs` can
  // hold a string, a list, a number, a boolean or `null` (issue #3207).
  //
  // THIS ARM IS THE ONE READER OF THAT BAG THAT RE-APPLIES RATHER THAN
  // DISPLAYS, which is why it REFUSES where `importableOutputKeys` fails
  // closed for the `Fn::ImportValue` sibling above. `Object.hasOwn('abcdef',
  // '0')` is TRUE, so an `OutputName: '0'` against a six-character bag passed
  // the membership test below and resolved the single CHARACTER `'a'` — a
  // value this deploy then SENDS to AWS as a live resource's property. The
  // `describeAvailableOutputs(Object.keys(outputs))` tail in that same
  // refusal echoed the fabricated keys back as the producer's outputs.
  //
  // Through the SHARED predicate, so the ABSENCE rule is the one every other
  // consumer of this bag uses: an absent bag is an ORDINARY record (the
  // deploy's failure-path saves write `outputs: currentState.outputs`, which
  // `JSON.stringify` drops when undefined) and falls through to the ordinary
  // not-found refusal below.
  //
  // `MalformedProducerRecordRefusalError`, an
  // `IntrinsicResolutionRefusalError` SUBCLASS, so an enclosing `Fn::Sub`
  // re-raises it instead of laundering it into a literal `${...}` shipped to
  // AWS (issue #1740) while `cdkd scrub`'s pre-pass can still tell it from
  // its siblings — the class's own JSDoc carries why that distinction has to
  // exist. `markNonRetryable` because the input is a persisted state record,
  // which no retry can change.
  if (!hasReadableOutputs(stateData.state)) {
    throw markNonRetryable(
      new MalformedProducerRecordRefusalError(
        `Fn::GetStackOutput: the state record of producer stack ${loggedStackName} ` +
          `(${displayIdent(loggedRegion)}) has no readable 'outputs' map — the record is malformed or ` +
          `truncated. cdkd refuses to resolve from it rather than reading it as a map: ` +
          `'Object.hasOwn' answers TRUE for '0' on a string and for an index on a list, so ` +
          `continuing would resolve ONE CHARACTER or element of the record as this ` +
          `reference's value and this deploy would send it to AWS. Inspect the producer's ` +
          `record with 'cdkd state show' --json, repair or remove it, then re-run.`
      )
    );
  }
  const outputs = stateData.state.outputs ?? {};
  // `Object.hasOwn` for the same reason as the CloudFormation-sourced arm
  // above (issue #2767); the sibling `Fn::ImportValue` path was already safe
  // because it tests membership through `importableOutputKeys`.
  if (!Object.hasOwn(outputs, outputName)) {
    const available = this.describeAvailableOutputs(Object.keys(outputs), context);
    // not-in-class(available): already rendered through describeAvailableOutputs, which masks each key.
    throw new Error(
      `Fn::GetStackOutput: output ${loggedOutputName} not found in stack ${loggedStackName} (${displayIdent(loggedRegion)}). ` +
        `Available outputs: ${available}`
    );
  }

  const value = outputs[outputName];
  // NAMES the reference, never the VALUE (issue #2133) — the SIBLING of the
  // `Fn::ImportValue` arms above and wrong for the same reason: "a producer's
  // state holds the `{{resolve:...}}` EXPRESSION" is a property of
  // POST-#1934 state, and `cdkd scrub`'s whole population is state written
  // before that, holding the plaintext.
  // not-in-class(roleArn ? `, RoleArn=${shownRoleArn}` : ''): the RoleArn argument, refused unless it is a literal template string.
  this.logger.info(
    `Resolved Fn::GetStackOutput: StackName=${loggedStackName}, Region=${loggedRegion}, ` +
      `OutputName=${loggedOutputName}${roleArn ? `, RoleArn=${shownRoleArn}` : ''} ` +
      `(${carriesDynamicReference(value) ? 'redacted dynamic reference' : 'literal value'})`
  );
  // Schema v8 (issue #668): record same-account reads so
  // `findDownstreamConsumers` can name `Fn::GetStackOutput`
  // consumers in the recreate warn block. Cross-account
  // `RoleArn`-based reads are deferred to a future schema bump
  // alongside a `sourceAccountId` field (the cross-account
  // consumer set is rarely large in practice, and the resolver
  // already pays an STS hop on the read side).
  if (!roleArn) {
    this.recordOutputRead(context, stackName, region, outputName);
  }

  // The SIBLING read path of `Fn::ImportValue`, reading the same persisted
  // `state.outputs` bag, so it carries the same redacted expressions and
  // needs the same re-resolution (issue #1934 Direction item 2).
  //
  // Except CROSS-ACCOUNT, where cdkd REFUSES rather than resolving. The
  // expression names a secret in the PRODUCER's account; the only credentials
  // in hand for a lookup are the consumer's, and resolving under them would
  // silently answer from a same-named secret in the WRONG account — the
  // disclosure shape issue #1957 exists to close, and strictly worse than
  // stopping. (The `RoleArn` credentials are assumed for a state READ and
  // carry no promise of `secretsmanager:GetSecretValue` / `ssm:GetParameter`;
  // resolving through them is a real option, but it is a permission-model
  // change that belongs in its own issue rather than smuggled in behind a
  // silent fallback.) Refusing is also better than the pre-#1934 behaviour of
  // shipping the literal token: a `{{resolve:...}}` string reaching AWS as a
  // password is a PREDICTABLE credential, not merely a broken value.
  //
  // `CrossAccountSecretRefusalError` — an `IntrinsicResolutionRefusalError`
  // SUBCLASS, so an `Fn::Sub` still re-raises it instead of laundering it into
  // a literal `${...}` — and non-retryable because the inputs (a persisted
  // state record, a template's literal `RoleArn`) are ones no retry can
  // change. The subclass exists because this is the ONE refusal in the family
  // that is PERMANENT: the other five (a stale placeholder ARN, a fabricated
  // account, an unenriched `Fn::GetAtt`, `--strict-getatt`, a malformed
  // `Fn::Split`) are all user-fixable, so a consumer treating the base class
  // as "no re-run can change this" downgrades all five (issue #2133 review).
  //
  // GATED ON THE DEPLOY PATH. Under `skipDynamicReferences` (the diff / no-op
  // comparison) nothing would be fetched from any account — a secret
  // reference is left unresolved by design — so there is no wrong-account
  // read to refuse, and refusing anyway would make `cdkd diff` fail (or, via
  // the diff calculator's best-effort catch, degrade to the raw intrinsic)
  // for a template that deploys fine everywhere except this one cross-account
  // output. The comparison then does what it does for every other secret:
  // compares expression against expression.
  if (roleArn && !context.skipDynamicReferences && carriesDynamicReference(value)) {
    // Only the RENDERING of `roleArn` changed here (issue
    // go-to-k/cdkd#3397). The SUBCLASS and the `markNonRetryable` marker are
    // untouched and must stay: `cdkd scrub` branches on
    // `CrossAccountSecretRefusalError` by `instanceof` down the cause chain
    // to tell this PERMANENT refusal from its user-fixable siblings
    // (`.claude/rules/intrinsic-refusals.md`), and the marker keeps a
    // substring-matching retry classifier from reading template-controlled
    // text as transient.
    // not-in-class(shownRoleArn): the RoleArn argument, refused unless it is a literal template string.
    throw markNonRetryable(
      new CrossAccountSecretRefusalError(
        `Fn::GetStackOutput: output ${loggedOutputName} of stack ${loggedStackName} (${displayIdent(loggedRegion)}) is a ` +
          `redacted dynamic reference, and this is a CROSS-ACCOUNT reference (RoleArn ` +
          `${shownRoleArn}). cdkd will not resolve a producer account's secret with the consumer's ` +
          `credentials — a same-named secret in the consumer account would answer instead. ` +
          `Export a non-secret value (e.g. the secret's ARN) and resolve it in the consumer ` +
          `stack, or reference the producer stack from within its own account.`
      )
    );
  }

  return await this.reresolveCrossStackValue(
    value,
    region,
    context,
    // All THREE operands, not the two the first pass moved. `loggedRegionText`
    // survived raw one operand to the left of two sanitized ones — the
    // "guard defeated by its own neighbour" shape, on the line the guard was
    // added to. It is not an exposure on the template-supplied path
    // (`isClientSafeRegion(canonicalizeRegion(...))` gates it, and no control
    // character lower-cases into `[a-z0-9-]`), but the DEFAULT path binds
    // `logTextOfLeaf(this.resolverRegion)`, which has no such gate. Sanitized
    // here rather than annotated, because this string flows into
    // `redactedAttributeReads[].display` and out through a
    // `ProvisioningError` message, and this whole tree is outside
    // `inMixedScope` so no fence watches it.
    //
    // (That sentence named the tree with a trailing glob until the scanner
    // fence caught it. A path separator directly followed by a star is a
    // block-comment opener as far as that stripper is concerned -- it runs
    // before line comments are removed, so a line comment is no shelter --
    // and the accidental span swallowed 1,036 characters of real code. Do
    // not write a glob in a comment in this file; the fence in
    // `tests/unit/deployment/resolver-display-masked-population.test.ts`
    // will refuse it, and its message will say so.)
    `Fn::GetStackOutput ${quotedRender(this.displayLeaf(outputName, context), "'")} (producer ${this.displayLeaf(stackName, context)} / ${this.displayLeaf(loggedRegionText, context)})`,
    sourceKey,
    // Issue #2274: this read is `outputs[outputName]` of that producer's
    // state, so the coordinate is exact — see the ImportValue arms. A
    // `RoleArn` makes it cross-ACCOUNT, which the coordinate cannot express,
    // so recovery is refused there rather than answered from the ambient
    // account's store.
    { stackName, region, outputKey: outputName, ...(roleArn ? { crossAccount: true } : {}) },
    loggedRegionText
  );
}

/**
 * Push a resolved `Fn::GetStackOutput` into the consumer's
 * recorded-output-reads bag (schema v8+, issue #668). Skips
 * duplicates within the SAME bag — multiple references to the
 * same `(sourceStack, sourceRegion, outputName)` triple emit one
 * entry. Same dedup discipline as `recordImport`.
 */
export function recordOutputRead(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  producerStack: string,
  producerRegion: string,
  outputName: string
): void {
  if (!context.recordedOutputReads) return;
  const dup = context.recordedOutputReads.some(
    (e) =>
      e.sourceStack === producerStack &&
      e.sourceRegion === producerRegion &&
      e.outputName === outputName
  );
  if (dup) return;
  context.recordedOutputReads.push({
    sourceStack: producerStack,
    sourceRegion: producerRegion,
    outputName,
  });
}

/**
 * A text transform replacing each RAW name this frame handed to another
 * module with the masked spelling it holds for it (issue
 * [#3234](https://github.com/go-to-k/cdkd/issues/3234)), or `undefined` when
 * no pair carries a mask.
 *
 * This is what the BAGS structurally cannot do. A bag masks by VALUE, and a
 * plaintext shorter than `MIN_NEEDLE_LENGTH` matches only as the WHOLE text,
 * so a 1-3 character secret an `Fn::Sub` assembled into a longer name is
 * invisible to it — while this frame knows the exact spans.
 *
 * A pair that DOES carry a mask contributes its raw spelling AND the spelling
 * the reader will actually see. `S3StateBackend` prints names through
 * `displayStackName`, whose first step is
 * `displaySafe(..., { asciiOnly: true })`, which REPLACES every non-printable
 * character with a space and then trims, so a secret carrying one is a
 * DIFFERENT string by the time it is quoted back and matching the raw form
 * alone would miss it while reporting success — the one-string-space rule
 * `outputs-export-alias.ts` states for its own scan: the text that was tested
 * and the text that is printed must be the same text. The CloudFormation
 * fallback does NOT sanitize (it rethrows the SDK's message as it is), so the
 * second spelling is inert at that call site and costs one comparison.
 *
 * NO MINIMUM LENGTH beyond non-empty, deliberately. A one-character masked
 * name rewrites every occurrence of that character in the sentence
 * (`a` -> `***` turns `us-east-1` into `us-e***st-1`), which is unreadable
 * but SAFE — the direction this function must never get wrong is printing
 * too little, not too much, and a floor here would be a floor on masking.
 *
 * `raw !== ''` is DEFENSIVE, and it is NOT the guard that handles a name
 * whose sanitized form is empty — that one inspects `shown`, below, and its
 * own comment says why. What this clause is not is redundant against
 * `raw !== masked`: `rememberLogTwin` has no empty-key guard and
 * `splitLogTwins` registers every piece it produces, so `registeredLogTwin`
 * can answer `***` for the empty string and make `maskSecretsRaw('')`
 * differ from `''`. Neither call site can reach it — both refuse an empty
 * name upstream — so it fences nothing measured today.
 *
 * LONGEST KEY FIRST — over every key, raw and sanitized alike, which is what
 * the comparator sees — so a key that contains another is rewritten as itself
 * rather than having the inner one replaced underneath it. **That ordering
 * is DEFENSIVE and this suite does not distinguish it** — measured: reversing
 * the comparator leaves every case green. The reason is that no case here
 * builds two raws that NEST: the one case with two surviving pairs masks a
 * stack name and a region that share no substring, and everywhere else one
 * pair is dropped for carrying no mask. It earns its place on the shape that
 * DOES diverge — a shorter raw whose mask is not a prefix of the longer's
 * (`q7` -> `***` beside `q7x` -> `***` turns `q7x` into `***x` shortest-first,
 * leaking the `x`) — which needs two separately recorded secrets, one of them
 * masked WHOLE, and is not constructed here. Recorded as measured rather than
 * claimed fenced.
 */
export function positionalNameMask(
  this: IntrinsicFunctionResolver,
  pairs: readonly (readonly [string, string])[]
): ((text: string) => string) | undefined {
  const substitutions = pairs
    // DROP AN UNMASKED PAIR FIRST, and the order is the whole correctness
    // argument rather than a tidying. Expanding first and filtering after
    // tests the tuple that came out of the expansion, so for a pair carrying
    // NO mask (`masked === raw`) the `[raw, raw]` entry is dropped while
    // `[shown, raw]` survives — a transform that rewrites the SANITIZED
    // spelling back into the RAW one. That un-does the `displaySafe` the
    // printing module applied on purpose (issue #3003), re-opening the
    // padded-name spoof `display-safe.ts` documents and putting a live
    // escape sequence back on the terminal, and it corrupts unrelated text
    // besides (`production` -> `prod uction` for a name `prod `). Measured,
    // and a leading space is enough to reach it — no non-ASCII needed,
    // because `trim()` is part of the transform.
    .filter(([raw, masked]) => raw !== '' && raw !== masked)
    .flatMap(([raw, masked]) => {
      // THE INVARIANT, and the only thing to check when touching this: a
      // substitution's REPLACEMENT must be at least as sanitized and at
      // least as masked as its KEY. Three review rounds each broke it a
      // different way and each was fixed by enumerating one more shape, so
      // it is stated once here and enforced at construction instead.
      //
      // PER ENTRY, and deliberately not a claim about the COMPOSITION. Each
      // replacement is masked against its OWN twin only, so one pair's
      // secret can survive as a literal inside another's replacement — the
      // longer key runs first and the shorter one no longer matches there.
      // Measured, and the twin's SPAN is what decides it, so the spelling
      // matters: stack `us-qq-1x` twinned `us-qq***x` beside region
      // `us-qq-1` twinned `us-***-1` leaves the region's `qq` inside the
      // stack entry's replacement. Twin the stack as `us-***-1x` instead —
      // the reading where both names mask the shared secret — and nothing
      // survives, which is why naming the span is part of the claim. That is
      // the `q7`/`q7x` residual recorded at the
      // sort, one composition over, and it is not a regression: every step
      // replaces text with a value at least as masked, so the result is
      // never weaker than the sentence the sink printed. Closing it means
      // feeding each replacement through the other entries' masks here.
      //
      // The raw key is what a sink that did NOT sanitize prints, so it takes
      // the twin as it is. The sanitized key is what a sink that DID prints,
      // and its replacement is sanitized to match — the twin keeps the
      // template's literal parts VERBATIM (only the secret span becomes
      // `***`), so an unsanitized replacement there puts the control
      // characters the printer had just removed back into the message, in
      // the top-level text neither `formatError` nor the logger sanitizes.
      const shown = displaySafe(raw, { asciiOnly: true });
      // A THIRD spelling (go-to-k/cdkd#3617): `S3StateBackend` now renders a
      // name through `displayStackName`, which puts a non-plain name inside a
      // JSON string -- so a `"` or `\` in it reaches the message ESCAPED, and
      // neither spelling above matches it there. Its replacement is escaped
      // the same way, so it is as sanitized and as masked as its key.
      const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);
      // ...and a FOURTH, the whole rendered token: `displayStackName` CUTS a
      // name past `STACK_REF_MAX_CODE_POINTS`, and a cut prefix matches none
      // of the whole-name keys -- a sub-floor secret inside it, or the shown
      // half of a secret straddling the cut, would print. The rendered token
      // is replaced with the rendering of the masked text, so it fails closed.
      const rendered = displayStackName(raw);
      const escapedPair = [
        ...(shown !== '' && escaped(shown) !== shown
          ? [[escaped(shown), escaped(displaySafe(masked, { asciiOnly: true }))] as const]
          : []),
        ...(rendered !== raw && rendered !== shown && rendered !== escaped(shown)
          ? [[rendered, displayStackName(displaySafe(masked, { asciiOnly: true }))] as const]
          : []),
      ];
      if (shown === raw) return [[raw, masked] as const, ...escapedPair];
      // Empty after sanitizing: substituting `''` splices the replacement
      // between every character, so that key contributes nothing. The
      // `shownMask` half of that test is UNREACHABLE and kept as the other
      // side of one rule rather than as a live case — `masked !== raw` is
      // already guaranteed above, so masking fired and the text contains
      // `***`, which `displaySafe` preserves.
      const shownMask = displaySafe(masked, { asciiOnly: true });
      return shown === '' || shownMask === ''
        ? [[raw, masked] as const]
        : ([[raw, masked] as const, [shown, shownMask] as const, ...escapedPair] as const);
    })
    .sort(([a], [b]) => b.length - a.length);
  if (substitutions.length === 0) return undefined;
  return (text: string): string => {
    let out = text;
    for (const [raw, masked] of substitutions) out = out.split(raw).join(masked);
    return out;
  };
}

/**
 * Mask a failure raised by a module this resolver handed RAW names to (issue
 * [#3234](https://github.com/go-to-k/cdkd/issues/3234)).
 *
 * Returns a masked CLONE of the whole cause chain, not a new wrapper, and
 * that is the point: `formatError` renders `Caused by: <cause>`, so masking
 * only a fresh top-level message leaves the original message one link down
 * and prints it anyway. The clone keeps the class, every own descriptor
 * (`markNonRetryable`'s non-enumerable symbol, `$metadata`, and `Code` /
 * `name` verbatim), other data values masked,
 * and the chain shape, so every reader that classifies this error still
 * does — see `maskSecretsInError`'s own doc.
 *
 * `pairs` are (raw, masked-log-text) for the names this frame handed over;
 * {@link positionalNameMask} turns them into the transform and owns why.
 */
export function maskStateReadError(
  this: IntrinsicFunctionResolver,
  error: unknown,
  pairs: readonly (readonly [string, string])[],
  context?: ResolverContext
): never {
  throw this.maskNamedError(error, this.positionalNameMask(pairs), context);
}

/**
 * {@link maskStateReadError}'s body, RETURNING the masked clone rather than
 * throwing it, so {@link namedRequestMasks} can hand the same answer to an
 * SDK call site (go-to-k/cdkd#3171). `extraMask` is a
 * {@link positionalNameMask} transform, or `undefined` for none.
 */
export function maskNamedError(
  this: IntrinsicFunctionResolver,
  error: unknown,
  extraMask: ((text: string) => string) | undefined,
  context?: ResolverContext
): unknown {
  // The SAME two bags in the SAME order as `maskSecretsRaw`, for the same
  // reason (issue #1903 round 2): on a nested-stack child the parent's
  // decrypted parameter plaintext lives in the inherited bag alone until a
  // `{Ref: <Param>}` resolution copies it across.
  //
  // `extraMask` rides the FIRST pass only. It is not idempotent against
  // itself in general — a masked spelling could in principle contain another
  // pair's raw text — and re-running it over text the first pass already
  // rewrote is how a second substitution would corrupt the first. One pass
  // is also all it needs: `maskSecretsInError` walks the whole chain, so a
  // single call reaches every link.
  let masked: unknown = error;
  let positional = extraMask;
  // ONE pass over the UNION of both bags (go-to-k/cdkd#4049): masked bag by
  // bag, the first bag's shorter needle cut a longer needle the second bag
  // held, and the rest of it printed. `hasMaskableValues`, not `size`
  // (go-to-k/cdkd#1998): a bag holding only log-only needles still masks.
  // The print-only corpus joins it (go-to-k/cdkd#4043): an error is RENDERED.
  const union = unionOfSecretBags([
    context?.inheritedSecrets,
    context?.recordedSecretValues,
    context?.printingSecrets,
  ]);
  if (hasMaskableValues(union)) {
    masked = maskSecretsInError(masked, union, positional);
    positional = undefined;
  }
  // FAIL CLOSED when both bags are empty. An earlier revision deleted this
  // arm, reasoning that a pair carries a mask only when the masker changed
  // the name, which needs a twin or a bag, and a twin's spans come from a
  // recorded secret — so `extraMask` should imply a non-empty bag.
  //
  // THAT ARGUMENT IS NOW FALSE, and go-to-k/cdkd#3426 is what falsified it:
  // the pairs are built with `displayMasked`, whose result differs from its
  // input for a CONTROL CHARACTER alone — no twin, no bag, nothing recorded.
  // `positionalNameMask`'s filter is `raw !== masked`, so a hostile name with
  // both bags empty now reaches this line. It was written as a fail-closed
  // arm against an invariant nobody fenced; it is a REACHED arm today. The
  // cost of not having it is the RAW name rethrown in the clear.
  // `maskSecretsInError` with an empty bag and a transform is exactly the
  // shape its widened early return admits.
  if (positional) masked = maskSecretsInError(masked, new Map(), positional);
  return masked;
}

/**
 * The three masks an AWS SDK call site owes the text the SDK produces about a
 * request that carried template-derived NAMES (go-to-k/cdkd#3171).
 *
 * The resolver masks every name it prints ITSELF through the name's log text
 * (go-to-k/cdkd#3150), but an SDK rejection QUOTES the name it refused back —
 * `ParameterNotFound: <name>`, a region in a describe failure — and that
 * text reached only the needle mask, whose substring arm has the
 * {@link MIN_NEEDLE_LENGTH} floor. A name an `Fn::Sub` assembled around a
 * 1-3 character secret printed masked in the resolver's own words and in the
 * clear a few characters later, in the SDK's.
 *
 * `pairs` are (raw name as SENT, that name's log text), the same shape
 * {@link positionalNameMask} takes and for the same reason; an unmasked pair
 * is dropped there. ONE helper returning all three, so a call site cannot
 * adopt one and miss the others:
 *
 * - `error` — a masked CLONE of the whole cause chain
 *   ({@link maskNamedError}), which keeps the class and every own descriptor,
 *   so `isThrottlingError` / `isMarkedNonRetryable` still classify it;
 * - `text` — a caught message about to be interpolated into a line or a
 *   throw, positional pass first, then {@link displayMasked};
 * - `retryLogger` — for `withRetry`, whose per-attempt `debug` line and
 *   give-up `warn` interpolate the SDK message verbatim.
 *
 * THE WHOLE NAME is the key, never its secret span alone: the substitution
 * rewrites every occurrence of the raw name wherever the SDK put it (inside
 * an ARN, after a colon). That is what reaches a sub-floor secret — the
 * whole name is longer than the secret — and it is also the bound: a name
 * the SDK re-encodes or truncates before quoting it is not matched, and a
 * masked name of 1-3 characters is matched only where the SDK quotes it
 * exactly, which may over-mask unrelated text (the SAFE direction
 * {@link positionalNameMask} documents).
 */
export function namedRequestMasks(
  this: IntrinsicFunctionResolver,
  pairs: readonly (readonly [string, string])[],
  context?: ResolverContext
): NamedRequestMasks {
  // A producer-region GUEST's own region rides along on every request: the
  // guest's clients are built for it, so an endpoint failure quotes it
  // (`getaddrinfo ENOTFOUND secretsmanager.<region>.amazonaws.com`) in text
  // no caller-supplied pair covers, and it is template-derived — the secret
  // ARN's region, which an `Fn::Sub` can assemble around a short secret
  // (go-to-k/cdkd#3171 review). An ordinary resolver's region has no log
  // text and adds nothing.
  const positional = this.positionalNameMask(
    this.explicitRegion !== undefined && this.explicitRegionLogText !== undefined
      ? [...pairs, [this.explicitRegion, this.explicitRegionLogText]]
      : pairs
  );
  const text = (message: string): string =>
    this.displayMasked(positional ? positional(message) : message, context);
  // `displaySafe` TRIMS, so a line `retry.ts` indents would lose its indent;
  // the leading SPACES are carried across (spaces only: nothing a terminal
  // interprets).
  const line = (message: string): string => {
    const indent = /^ */.exec(message)?.[0] ?? '';
    return indent + text(message.slice(indent.length));
  };
  return {
    error: (error) => this.maskNamedError(error, positional, context),
    text,
    retryLogger: {
      debug: (message) => this.logger.debug(line(message)),
      // UNREACHABLE from `sendWithThrottleRetry` today: `withRetry` warns only
      // after a propagation / cooldown / server-error retry, and a caller
      // passing its own `isRetryable` counts none. Masked anyway, since the
      // interface makes it optional rather than absent.
      warn: (message) => this.logger.warn(line(message)),
    },
  };
}

/**
 * Read the producer's state from the SAME AWS account (no RoleArn).
 *
 * Uses the consumer's shared `context.stateBackend` — the same backend
 * the consumer used to read / write its own state. The same-account
 * path covers cross-region cleanly because the bucket name is
 * account-scoped (not region-scoped).
 */
export async function getSameAccountStackState(
  this: IntrinsicFunctionResolver,
  stackName: string,
  region: string,
  context: ResolverContext
): ReturnType<S3StateBackend['getState']> {
  if (!context.stateBackend) {
    throw new Error('Fn::GetStackOutput: state backend is required for cross-stack references');
  }
  return context.stateBackend.getState(stackName, region);
}

/**
 * Read the producer's state from a DIFFERENT AWS account (RoleArn set).
 *
 * Pipeline:
 *   1. Parse `roleArn` for the producer's account id (rejects malformed
 *      ARNs up front with a clear message — no opaque STS error later).
 *   2. `sts:AssumeRole` against `roleArn`, cached per role for the
 *      deploy lifetime (typical: 1 STS hop covering many `Fn::GetStackOutput`
 *      sites in the same deploy).
 *   3. Derive the producer's canonical state bucket
 *      (`cdkd-state-{producerAccountId}`) and auto-detect its region
 *      via `GetBucketLocation` with the assumed credentials.
 *   4. Build a fresh, narrowly-scoped `S3StateBackend` against that
 *      bucket with the assumed credentials and call `getState` —
 *      reuses the entire state-parsing + schema-version-tolerance
 *      machinery (legacy `version: 1` keys, migration warnings, etc.).
 *
 * The constructed `S3Client` and backend live only for the duration of
 * this call. cdkd does NOT mutate the process's `AWS_*` env vars (that
 * would leak the assumed credentials into every subsequent provisioning
 * client — opposite of what we want; provisioning still runs under the
 * consumer's normal credentials).
 */
export async function getCrossAccountStackState(
  this: IntrinsicFunctionResolver,
  roleArn: string,
  stackName: string,
  region: string,
  context: ResolverContext
): ReturnType<S3StateBackend['getState']> {
  const parsed = parseIamRoleArn(roleArn);
  if (!parsed) {
    // THE site of this class most worth sanitizing, and the reason is the
    // control flow (issue go-to-k/cdkd#3397): this is the refusal for a value
    // that JUST FAILED `parseIamRoleArn`, so the text reaching it is by
    // construction one no shape gate accepted — the argument issue
    // [#3377](https://github.com/go-to-k/cdkd/issues/3377) made about
    // `writeProfileCredentialsFile` interpolating the name it was refusing.
    // Sanitized at the RENDER rather than by narrowing `parseIamRoleArn`,
    // which must keep returning `undefined` for exactly these inputs.
    //
    // A plain value keeps its hand-written `'...'`. Any other is shown, since
    // the operator needs it to fix the template, as `displayIdent`'s JSON
    // shell-quoted by `shellBoundedDisplay`: a `'` in the value closed
    // cdkd's own quote, and bare JSON would let `$( )` run in a pasted
    // sentence (go-to-k/cdkd#3950).
    // not-in-class(displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })): the RoleArn argument, refused unless it is a literal template string.
    const shownRoleArn = displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS });
    // Whitespace FIRST: the round-trip alone admits a value that is
    // `displayIdent`'s own cut output (the cap's worth of plain characters,
    // then ` [cut: N more characters withheld]`), which then sits inside
    // cdkd's `'...'` with `: ` in it.
    const plain = !/\s/.test(roleArn) && shownRoleArn === roleArn;
    const bounded = plain ? `'${shownRoleArn}'` : shellBoundedDisplay(shownRoleArn);
    // A described value reads as a noun phrase, not as the ARN itself.
    const subject =
      bounded === UNSHOWABLE_VALUE
        ? `the RoleArn argument (${UNSHOWABLE_VALUE})`
        : `RoleArn ${bounded}`;
    throw new Error(
      `Fn::GetStackOutput: ${subject} is not a valid IAM role ARN. ` +
        `Expected shape: arn:<partition>:iam::<12-digit-account-id>:role/<role-name>` +
        ` (e.g. arn:aws:iam::123456789012:role/MyRole, arn:aws-us-gov:iam::...).`
    );
  }

  const credentials = await assumeRoleForCrossAccountStateRead(roleArn);
  const { bucket, region: bucketRegion } = await resolveCrossAccountStateBucket(
    parsed.accountId,
    credentials
  );

  // Reuse the consumer-side state prefix (the cdkd convention is `cdkd`
  // and is the same on both sides — the producer's own `cdkd deploy`
  // wrote under the same prefix). Pulling the live value off the
  // consumer's backend keeps us in sync with `--state-prefix`
  // overrides at the consumer side; in practice both sides almost
  // always default to `cdkd`.
  const prefix = context.stateBackend?.prefix ?? 'cdkd';

  const s3 = new S3Client({
    ...awsClientDefaults(),
    region: bucketRegion,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    // Suppress the SDK's noisy "unknown Body length" warning; matches
    // the suppression in `AwsClients` and the consumer-side state
    // backend's region-rebuild path.
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  const crossAccountBackend = new S3StateBackend(
    s3,
    { bucket, prefix },
    {
      region: bucketRegion,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
    }
  );

  return crossAccountBackend.getState(stackName, region);
}
