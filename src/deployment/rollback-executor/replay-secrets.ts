import { plainOrDescribed, quotedOrDescribed } from '../../utils/pasteable-command.js';
import type { ResourceState } from '../../types/state.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { CdkdError } from '../../utils/error-handler.js';
import { IntrinsicFunctionResolver, type ResolverContext } from '../intrinsic-function-resolver.js';
import {
  scrubResourceRecord,
  redactSecretsForState,
  dynamicReferenceTokens,
  STATE_DERIVED_RULES,
  type RecordedSecretValues,
} from '../secret-redaction.js';
// `ReplayResolvers` below calls the classifier; `rollback-executor.ts`
// re-exports it under its historical address.
import {
  classifyReplaySecretRegion,
  regionLessSecretName,
} from '../secret-region-classification.js';
import { type ProducerRegionEvidence } from '../producer-regions-scope.js';
import { type RollbackExecutorContext } from './types.js';
import { quotedPlainOr, shownLogicalId, rerunRollbackPhrase } from './messages.js';

/**
 * What a replay hands a nested-stack row it reverts (go-to-k/cdkd#4174): its
 * own producer-region evidence, which the child journal replay unions with its
 * own reads.
 */
export function replayProducerRegionEvidence(ctx: RollbackExecutorContext): ProducerRegionEvidence {
  return {
    regions: ctx.importedProducerRegions ?? [],
    // A context that set no regions at all says nothing about its reads, so a
    // child inheriting from it must not treat them as known to be none.
    complete: ctx.importedProducerRegions !== undefined && ctx.producerRegionsIncomplete !== true,
  };
}

/**
 * The replay's resolvers: the stack's own, plus one pinned sibling per FOREIGN
 * region an ARN-named reference asks for (issue #2057).
 *
 * One instance per replay, not per op — the resolved-value cache lives on the
 * resolver INSTANCE since issue #1933, so a resolver per op would re-fetch every
 * referenced secret once per op. The pinned siblings are cached here for the
 * same reason: a 100-op replay of a bag carrying one foreign ARN must pay one
 * `GetSecretValue`, not a hundred.
 *
 * A pinned sibling is a PLAIN resolver, deliberately NOT the resolver class's
 * own `producerRegionGuest` (which the class sets on the siblings
 * `resolverForProducerRegion` builds, to stop a foreign region pinning a verdict
 * in the process-global `recordedSecretExpressions` store — the issue #1933
 * shape, where an `ssm` parameter whose TYPE differs by region has one region's
 * verdict decide the other's redaction).
 *
 * WHY A GUEST FLAG IS NOT NEEDED HERE, and the argument has to be this one
 * rather than "only `secretsmanager` routes to a sibling" (that earlier claim
 * was FALSE — `resolveSSMReference` joins its colon-split tail back together, so
 * an `ssm` reference CAN name a full ARN and CAN therefore route here):
 *
 *   {@link ReplayResolvers.forRegion} is reached ONLY from a `named-region`
 *   verdict, which `classifyReplaySecretRegion` returns only when the
 *   SECRET_ID / parameter name starts with `arn:` and carries a region. So a
 *   pinned sibling only ever resolves an expression whose KEY EMBEDS THE
 *   REGION IT IS BEING RESOLVED IN.
 *
 * The store is keyed by the expression string alone, and that is exactly what
 * makes #1933 possible: two regions sharing one key. An ARN-form key cannot be
 * shared by two regions, so a verdict pinned from a sibling can never contradict
 * another region's for the same key. If a future change ever routes a
 * region-LESS expression to `forRegion`, this argument dies with it and the
 * sibling needs the guest flag.
 */
export class ReplayResolvers {
  /** The stack's own resolver — every `local` verdict resolves through this. */
  readonly primary: IntrinsicFunctionResolver;
  private readonly pinned = new Map<string, IntrinsicFunctionResolver>();
  private readonly stackRegion: string;

  constructor(stackRegion: string) {
    this.stackRegion = stackRegion;
    this.primary = new IntrinsicFunctionResolver(stackRegion);
  }

  /** The resolver that must answer for `region` — `primary` when it is the stack's own. */
  forRegion(region: string): IntrinsicFunctionResolver {
    const target = canonicalizeRegion(region);
    if (target === canonicalizeRegion(this.stackRegion)) return this.primary;
    const cached = this.pinned.get(target);
    if (cached) return cached;
    const scoped = new IntrinsicFunctionResolver(target);
    this.pinned.set(target, scoped);
    return scoped;
  }
}

/**
 * The refusal an `ambiguous` replay reference throws (issue #2057).
 *
 * A plain throw, like the final-snapshot refusals in `names.ts` and for the same
 * reason: the per-op catch in {@link replaySingle} /
 * {@link replayFailedOperations} counts it as a failure, which keeps the
 * journal segment and lets the user re-run once the reference is disambiguated.
 * Refusing is strictly better than the alternative it replaces — resolving a
 * producer-region reference against the consumer's region does not fail, it
 * succeeds with the WRONG credential and writes it to a resource that is live.
 *
 * Names the reference, the regions, and the remedy. Never the resolved value:
 * nothing here has resolved anything yet, and the expression is the same string
 * `state.json` already stores in the clear.
 */
function regionAmbiguousReplaySecretError(
  logicalId: string,
  propertyPath: string,
  secretName: string,
  foreignProducerRegions: readonly string[],
  consumerRegion: string,
  execCtx: Pick<RollbackExecutorContext, 'nestedChildStack'>
): CdkdError {
  const where =
    propertyPath === '' ? '' : ` property ${quotedPlainOr(propertyPath, 'property path')}`;
  return new CdkdError(
    // Every value is described when not plain, never printed raw: the message
    // ends by naming `cdkd rollback` (go-to-k/cdkd#4214).
    `Rollback of ${shownLogicalId(logicalId)}${where} cannot re-resolve the secret reference ` +
      `${quotedPlainOr(secretName, 'secret name')}: the reference carries no region of its own, ` +
      `and this stack read across a region boundary (producer region(s) on record: ` +
      `${foreignProducerRegions.map((r) => plainOrDescribed(r, 'region')).join(', ')}), so it ` +
      `may have been resolved in one of those ` +
      `rather than in ${quotedOrDescribed(consumerRegion, 'region')}. A secret of the same name in two regions is two ` +
      `independent values, so replaying this would write the WRONG secret to a live resource. ` +
      `Refusing instead. Resolve the reference in its own region and set the property ` +
      `directly (or spell it as a full ARN, which names its region and is resolved there), ` +
      `then re-run ${rerunRollbackPhrase(execCtx, "'cdkd rollback'")}.`,
    'ROLLBACK_SECRET_REGION_AMBIGUOUS'
  );
}

/**
 * go-to-k/cdkd#4174: with a nested child's parent regions unknown
 * (`producerRegionsIncomplete`), a region-less reference that classifies
 * `local` may still be the parent's, so the leaf is refused before any of its
 * references is fetched. Kept out of {@link resolveLeafByRegion}, whose body
 * `cdkd drift` mirrors (`drift-leaf-region-walk-mirrors-replay.test.ts`).
 * Exported for its unit test only.
 */
export function refuseUnprovenReplaySecret(
  leaf: string,
  propertyPath: string,
  logicalId: string,
  execCtx: RollbackExecutorContext
): void {
  if (execCtx.producerRegionsIncomplete !== true) return;
  for (const token of dynamicReferenceTokens(leaf)) {
    const verdict = classifyReplaySecretRegion(
      token,
      execCtx.region,
      execCtx.importedProducerRegions
    );
    const name = verdict.kind === 'local' ? regionLessSecretName(token) : undefined;
    if (name !== undefined) {
      throw regionUnknownReplaySecretError(logicalId, propertyPath, name, execCtx.region, execCtx);
    }
  }
}

/**
 * The refusal for a region-less secret reference in a nested child's replay
 * whose parent's producer regions are unknown (go-to-k/cdkd#4174). Same code
 * as {@link regionAmbiguousReplaySecretError}: the same decision, taken on
 * missing evidence rather than on a foreign region on record.
 */
function regionUnknownReplaySecretError(
  logicalId: string,
  propertyPath: string,
  secretName: string,
  consumerRegion: string,
  execCtx: Pick<RollbackExecutorContext, 'nestedChildStack'>
): CdkdError {
  const where =
    propertyPath === '' ? '' : ` property ${quotedPlainOr(propertyPath, 'property path')}`;
  return new CdkdError(
    // Described when not plain, as in `regionAmbiguousReplaySecretError`
    // (go-to-k/cdkd#4214).
    `Rollback of ${shownLogicalId(logicalId)}${where} cannot re-resolve the secret reference ` +
      `${quotedPlainOr(secretName, 'secret name')}: the reference carries no region of its own, ` +
      // No apostrophe in this prose (review of #4270): a `'` pairs with the
      // quote around a region or name and leaves what sits between bare.
      `and this is a nested ` +
      `stack, and the cross-region reads its parent made are not known to this replay, so the parent may ` +
      `have resolved it in another region than ${quotedOrDescribed(consumerRegion, 'region')}. A secret of the same name in ` +
      `two regions is two independent values, so replaying this could write the WRONG secret to ` +
      `a live resource. Refusing instead. Where the journal of the top-level stack still holds this ` +
      `run, roll back the top-level stack instead, which supplies its regions. Otherwise resolve ` +
      `the reference in its own region and set the property directly (or spell it as a full ` +
      `ARN, which names its region and is resolved there), then re-run ` +
      `${rerunRollbackPhrase(execCtx, "'cdkd rollback'")}.`,
    'ROLLBACK_SECRET_REGION_AMBIGUOUS'
  );
}

/**
 * Re-resolve one LEAF string, sending each `{{resolve:...}}` reference in it to
 * the region {@link classifyReplaySecretRegion} says must answer (issue #2057).
 *
 * Refuses FIRST, over the whole leaf, before any reference is fetched: a leaf
 * can splice several references together, and resolving the safe ones first
 * would leave half a credential fetched (and cached, and recorded as a
 * redaction needle) for an op that is about to be refused anyway.
 *
 * Then TWO paths, and the split is deliberate rather than an optimisation:
 *
 *  - With no foreign-region reference — every leaf on every existing code path
 *    — the leaf goes to `resolveDynamicReferences` WHOLE, exactly as before this
 *    change. That method has its own well-tested substitution semantics (it
 *    collects matches from the ORIGINAL string, so a resolved plaintext that is
 *    itself token-shaped is never re-resolved — issue #1917), and this change
 *    does not want to relitigate any of it.
 *  - With one, the leaf is rebuilt segment by segment so each reference can be
 *    resolved by its OWN region's resolver. `resolveDynamicReferences` resolves
 *    every token in the string it is handed with the one resolver it is called
 *    on, so a mixed leaf cannot be served by a single call. Each token is
 *    resolved ALONE and its result concatenated, which means no resolved value
 *    is ever re-scanned for tokens either.
 *
 * `dynamicReferenceTokens` returns the tokens in order and non-overlapping, so
 * walking the leaf with a moving `indexOf` cursor reproduces their positions
 * exactly, duplicates included.
 */
export async function resolveLeafByRegion(
  leaf: string,
  propertyPath: string,
  logicalId: string,
  execCtx: RollbackExecutorContext,
  resolvers: ReplayResolvers,
  resolverContext: ResolverContext
): Promise<string> {
  // ONE spelling of the token scan, shared with `secret-redaction.ts` (issue
  // #1936): a private regex here would answer a different question from the one
  // the resolver is about to ask, which is the whole defect that constant fixed.
  const tokens = dynamicReferenceTokens(leaf);
  const verdicts = tokens.map(
    (token) =>
      [
        token,
        classifyReplaySecretRegion(token, execCtx.region, execCtx.importedProducerRegions),
      ] as const
  );

  for (const [, verdict] of verdicts) {
    if (verdict.kind === 'ambiguous') {
      throw regionAmbiguousReplaySecretError(
        logicalId,
        propertyPath,
        verdict.secretName,
        verdict.foreignProducerRegions,
        execCtx.region,
        execCtx
      );
    }
  }

  if (!verdicts.some(([, verdict]) => verdict.kind === 'named-region')) {
    return await resolvers.primary.resolveDynamicReferences(leaf, resolverContext);
  }

  let out = '';
  let cursor = 0;
  for (const [token, verdict] of verdicts) {
    const at = leaf.indexOf(token, cursor);
    // Unreachable while the tokens come from a scan of THIS string, so this is
    // a guard against a future scanner change — and the direction it fails in
    // is the whole point. Handing the leaf back to the primary resolver would
    // send a token whose foreign region is already KNOWN to the consumer's
    // region: issue #2057 verbatim, reintroduced by the guard meant to prevent
    // a regression. Fail closed instead; a rollback that stops is recoverable,
    // a wrong secret written to a live resource is not.
    if (at < 0) {
      throw new CdkdError(
        `Rollback of ${logicalId}${propertyPath === '' ? '' : ` property '${propertyPath}'`} ` +
          `could not locate a scanned dynamic reference in the value it was scanned from. ` +
          `Refusing rather than resolving it in '${execCtx.region}', which would be the wrong ` +
          `region for a reference that names another one. This is an internal invariant ` +
          `failure — please report it with the resource type and property path.`,
        'ROLLBACK_SECRET_TOKEN_SCAN_MISMATCH'
      );
    }
    out += leaf.slice(cursor, at);
    const resolver =
      verdict.kind === 'named-region' ? resolvers.forRegion(verdict.region) : resolvers.primary;
    out += await resolver.resolveDynamicReferences(token, resolverContext);
    cursor = at + token.length;
  }
  return out + leaf.slice(cursor);
}

/**
 * Redact resolved secret plaintext back out of a post-rollback state record
 * (GHSA fix). The record's `properties` may be the provider's
 * `effectiveProperties`, which can echo the value we just resolved for the
 * provider call — so scrub it with the same per-op secrets map before it is
 * persisted.
 *
 * `journaledProps` is the POSITION source (issue #1910): the JOURNALED previous
 * properties, whose leaves still carry the unresolved `{{resolve:...}}`
 * expressions this replay resolved FROM. Without it two expressions sharing one
 * resolved value collapse onto whichever the replay recorded last, so the state
 * this rollback writes disagrees with the template at one leaf and the next
 * deploy reports a change that never converges — the same defect the four
 * deploy-side writers had, arriving here through the replay instead.
 *
 * It takes `STATE_DERIVED_RULES`, which is every relaxation. The source is a
 * persisted record, so it holds no PUBLIC expressions (a `String` ssm reference
 * is stored resolved) and any `{{resolve:...}}` in it is by construction a
 * secret — that is `trustAnyExpression`. And the bag WAS produced by resolving
 * that source (`resolveReplayProps` -> the provider's `effectiveProperties`),
 * so the two have identical structure and positional array descent is sound —
 * that is `descendArrays`. It is also the SAME generation, resolved one
 * statement earlier in this call — that is `sourceIsSameGeneration`, and this
 * writer is one of only two that can honestly claim it.
 *
 * Using `STATE_SOURCED_READBACK_RULES` here reads plausible and is wrong in the
 * quiet direction: it turns BLIND positional array descent off. BLIND is
 * load-bearing, and an earlier revision of this paragraph omitted it — the
 * concrete loss is narrower than "positional descent is off" makes it sound,
 * by TWO mechanisms rather than one:
 *
 *  - Since issue #1915 a `Tags[]` / ECS `Environment[]` element is reached by
 *    the order-independent KEYED descent either way.
 *  - Since issue #2012 an UNKEYED list is reached too, under corroboration.
 *    That is not a general relaxation: swapping this constant in would satisfy
 *    all three conjuncts of `isReadbackProjectedFromState`
 *    (`trustAnyExpression && !descendArrays && sourceIsSameGeneration`), which
 *    ARMS `refuseUncertifiedReadbackPositions`, and its unkeyed arm walks
 *    element i against element i whenever `unkeyedArrayPairsByAnchors`
 *    corroborates the alignment (index counts match; every position whose
 *    SOURCE subtree carries no dynamic reference is deep-equal on both sides;
 *    every reference-bearing element carries a distinguishing anchor of its own
 *    or, being a bare reference leaf, leans on the array's literal frame; and
 *    no two reference-bearing elements share an order-insensitive anchor
 *    signature).
 *
 * So the residual loss is narrower again: an unkeyed list whose positions ALSO
 * fail to corroborate. The CONCLUSION is unchanged — `STATE_DERIVED_RULES` is
 * still right here, for the reason one paragraph up (the bag was produced by
 * resolving the source, so the two correspond positionally by construction and
 * need no corroboration to say so). What changes is only how much a reader
 * should think the alternative costs (issue #2691).
 *
 * No-op when the op resolved no secret.
 */
export function redactRollbackRecord(
  record: ResourceState,
  secrets: RecordedSecretValues,
  journaledProps?: Record<string, unknown>
): ResourceState {
  if (secrets.size === 0) return record;
  // Deliberately NOT passed as `sourceProperties`: that parameter means "a
  // TEMPLATE bag", which suppresses the trust-any-expression relaxation a state
  // bag is entitled to. Positioning `properties` against the journaled bag is
  // done here, and `scrubResourceRecord` then handles `attributes` /
  // `observedProperties` from the already-redacted record as usual.
  const positioned =
    journaledProps === undefined
      ? record
      : {
          ...record,
          properties: redactSecretsForState(
            record.properties,
            secrets,
            journaledProps,
            STATE_DERIVED_RULES
          ),
        };
  return scrubResourceRecord(positioned, secrets);
}
