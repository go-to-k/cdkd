import { getLogger } from '../utils/logger.js';
import { commandHole, pasteableCommand, shellQuote } from '../utils/pasteable-command.js';
import { withCurrentResourceSecrets } from './resource-secrets-scope.js';
import { withProducerRegions } from './producer-regions-scope.js';
import {
  equalIdNamesDifferentResources,
  equalIdNamesSameResource,
  findNestedStackTypeChanges,
  renderNestedStackTypeChangeRefusal,
} from './type-change-guard.js';
import { refuseNoValueOutputs } from './output-value-preflight.js';
import { bold, cyan, gray, green, red, yellow } from '../utils/colors.js';
import { formatResourceLine } from '../utils/resource-line.js';
import { getLiveRenderer } from '../utils/live-renderer.js';
import {
  ProvisioningError,
  ResourceTimeoutError,
  ResourceUpdateNotSupportedError,
  CdkdError,
} from '../utils/error-handler.js';
import {
  displayAwsMessage,
  displayIdent,
  displayStackName,
  displaySafe,
  isPasteableIdent,
  safeMsg,
} from '../utils/display-safe.js';
import {
  refuseMalformedOutputs,
  refuseMalformedOrphanRecords,
  refuseMalformedOrphans,
  refuseMalformedResourceEntriesForDeploy,
  refuseMalformedResourcesForDeploy,
} from '../state/malformed-resources-bag.js';
import {
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../provisioning/stateful-types.js';
import {
  withStackName,
  applyDefaultNameForFallback,
  withoutGeneratedFallbackName,
} from '../provisioning/resource-name.js';
import { explicitNamePropertyFor } from '../provisioning/resource-name.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import {
  IntrinsicFunctionResolver,
  isStalePlaceholderArnAttribute,
} from './intrinsic-function-resolver.js';
import {
  isHealExcludedType,
  mergeHealedAttributes,
  type StaleAttributeHealOutcome,
} from './stale-attribute-heal.js';
import { readRecordAttributes } from './read-only-attribute-healer.js';
import { withSharedDrainBudget } from './drain-budget.js';
import {
  markSameGenerationBag,
  redactSecretsForState,
  mergeResolvedPairs,
  scrubResourceRecord,
  maskSecretsInText,
  maskSecretsInError,
  createSecretMasker,
  hasMaskableValues,
  recordNestedStackParameterExpressions,
  inheritNestedStackParameterAssociations,
  inheritedParameterExpression,
  carriesSecretMask,
  carriesFreshNoEchoValue,
  freshNoEchoLeafPositions,
  recordMaskOnlyValuesIn,
  recordRecoverableMaskedOutput,
  wholeStringLeavesOf,
  TEMPLATE_SOURCED_RULES,
  recordLogOnlyParameterValue,
  literalSplitDelimitersOf,
  createUnionSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
  type SecretMasker,
} from './secret-redaction.js';
import { DagExecutor } from './dag-executor.js';
import {
  isInlinePolicyClaimedByCompletedWriter,
  type InlinePolicyWrite,
} from './inline-policy-claims.js';
import type {
  CloudFormationTemplate,
  CreateContext,
  EffectivePropertiesResult,
  InlinePolicyClaimed,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceProvider,
  ResourceUpdateResult,
} from '../types/resource.js';
import {
  renderNameHeldElsewhere,
  probeErrorMeansNameHeld,
  probeFoundSameId,
  renderReplacementNameChange,
  replacementCreateAdoptsName,
  replacementMovesEventBus,
  replacementNameProbe,
  replacementOrderIsCaseSensitive,
  replacementOldHoldsSentName,
  replacementRequestsDifferentName,
  type ReplacementNameChange,
} from './replacement-name-holder.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  shouldRetainResource,
  exportNamesCarriedFrom,
  skippedOutputsCarriedFrom,
  orphansCarriedFrom,
  orphansAfterRollback,
  type StackOrphanRecord,
  importableOutputKeys,
  importableOutputs,
  hasUnverifiableParameterRefusal,
  type StackState,
  type StateImportEntry,
  type StateOutputReadEntry,
  type ResourceState,
  type ResourceChange,
  type PropertyChange,
} from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import {
  extractDeploymentEventError,
  type DeploymentResourceOperation,
} from '../types/deployment-events.js';
import type { LockManager } from '../state/lock-manager.js';
import type { ExportIndexStore } from '../state/export-index-store.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
  ccBrokenReason,
  type ProvisionedBy,
} from '../provisioning/provider-registry.js';
import { slowCcOperationTimeoutMs } from '../provisioning/slow-cc-operation-timeouts.js';
import { makeCanonicalizePropertiesFn } from '../provisioning/canonicalize-properties.js';
import {
  withoutAcceptedSilentDropProperties,
  withoutSilentDropProperties,
} from '../provisioning/property-coverage.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  effectiveDeletionPolicy,
  replacementDeletePolicy,
  unsupportedFinalSnapshotError,
} from '../provisioning/final-snapshot.js';
import { getAwsClients } from '../utils/aws-clients.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../utils/ambient-client-defaults.js';
import { injectiveKey } from '../state/record-keys.js';
import {
  prefetchCreateOnlyPropertyPaths,
  templateResourceTypes,
  type CreateOnlyPrefetch,
} from '../provisioning/create-only-properties.js';
import { hasNoRegistrySchema } from '../provisioning/describe-type.js';
import { withUnchangedSecretPrincipalLists } from '../provisioning/iam-policy-targets.js';
import { TemplateParser } from '../analyzer/template-parser.js';
import { skippedOutputsEqual } from '../analyzer/skipped-outputs.js';
import {
  bagHoldsSecretExpression,
  keptWholeReasonText,
  mergeNoChangeOutputs,
  type NoChangeOutputsMerge,
} from './no-change-outputs-merge.js';
import {
  IMPLICIT_DELETE_DEPENDENCIES,
  computeImplicitDeleteEdges,
} from '../analyzer/implicit-delete-deps.js';
import { withRetry, type RetryLogger } from './retry.js';
import { maskingRetryLogger } from './masking-retry-logger.js';
import {
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
  isUpdateUnsupportedError,
  markNonRetryable,
} from './retryable-errors.js';
import { withResourceDeadline } from './resource-deadline.js';
import { deleteSkipReason, deleteSkippedMessage } from './delete-outcome.js';
import { updatePartialMessage, updatePartialReason } from './update-outcome.js';
import { findUnrewrittenAssetReferences } from '../assets/asset-redirect.js';
import {
  type CompletedOperation,
  type FailedOperation,
} from './rollback-executor.js';
import { NESTED_PENDING_PARENT_REASON, type SettledNestedRows } from './nested-child-journal.js';
import { isInterruptedWaitError } from '../provisioning/interrupt-watch.js';
import { isWaitAbandonedError } from '../provisioning/wait-abandoned.js';
import {
  DEFAULT_RESOURCE_TIMEOUT_MS,
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  type DeployEngineOptions,
  type DeployResult,
} from './deploy-engine-options.js';
import { deriveLabelRouting } from './label-routing.js';
import {
  isReplacementCeiling,
  keyOrderFreeJson,
  liveHoldsFreshLeaves,
  outputMapsEqual,
  type FreshNoEchoCeilingVerdict,
  type FreshNoEchoReadback,
} from './deploy-value-equality.js';
import * as nameCollisionMixin from './deploy-engine-name-collision.js';
import * as outputsMixin from './deploy-engine-outputs.js';
import * as rollbackMixin from './deploy-engine-rollback.js';
import * as observedCaptureMixin from './deploy-engine-observed-capture.js';
export {
  DEFAULT_RESOURCE_TIMEOUT_MS,
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  type DeployEngineOptions,
  type DeployResult,
} from './deploy-engine-options.js';
export { deriveLabelRouting, type LabelRoutingState } from './label-routing.js';

/**
 * The bag a resource with no recorded secret masks against (issue #2038).
 * Shared so the "no entry" path allocates nothing and — more usefully — so
 * every masking site takes the SAME branch: `maskSecretsInText` /
 * `maskSecretsInError` both return their input unchanged for an empty bag, so
 * an absent entry and an empty one cannot behave differently. Never written to.
 */
export const EMPTY_SECRETS: RecordedSecretValues = new Map();

/**
 * One entry the resolver pushed into `ResolverContext.redactedAttributeReads`
 * (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)).
 *
 * An INLINE TYPE-ONLY alias rather than a named import, for the reason this
 * file states at its other resolver types: 72 of the 80 suites that `vi.mock`
 * `intrinsic-function-resolver.js` use a bare factory exposing only
 * `getAccountInfo`, so a new VALUE import reds them with a missing-export
 * error. A type import is erased at build time and reds nothing — which is
 * also why the two consumers below can now share the resolver's own
 * definition instead of re-deriving the structure from a rendered string.
 */
type RedactedAttributeRead = import('./intrinsic-function-resolver.js').RedactedAttributeRead;

/**
 * Reported up from a template-DELETE whose provider returned
 * `{ outcome: 'skipped' }` (issue #1762).
 *
 * It travels as a RETURN VALUE rather than a thrown error because the deploy
 * deliberately continues: the state record is kept, so the next run re-attempts
 * the delete. The two callers that must know are the event emitter (a skip is
 * not `RESOURCE_SUCCEEDED`) and the DELETE executor, whose rollback journal
 * must NOT record a delete that never happened.
 */
interface DeleteSkipSignal {
  /** The provider's `ResourceDeleteResult.reason` — always present on a skip. */
  deleteSkipped: string;
}

/**
 * The UPDATE-side twin of {@link DeleteSkipSignal} (issue #1819): the provider
 * updated the resource but did NOT retire something the update owned.
 *
 * Carried separately from `deleteSkipped` for the same reason those two counters
 * are separate: the row's own resource WAS updated here, so the wrapper still
 * emits `RESOURCE_SUCCEEDED` for it and adds a `RESOURCE_SKIPPED` naming the
 * survivor. Collapsing them would make the events store claim the updated
 * resource was skipped.
 */
interface UpdatePartialSignal {
  /** The provider's `ResourceUpdateResult.reason` — required on `'partial'`. */
  updatePartial: string;
}

/** What `provisionResourceBody` can report upward about a non-clean outcome. */
type ResourceOutcomeSignal = Partial<DeleteSkipSignal> & Partial<UpdatePartialSignal>;

/**
 * Per-resource operation tallies threaded through `provisionResource`.
 *
 * `skipped` and `deleteSkipped` are NOT the same thing and must never be
 * merged: `skipped` counts resources whose UPDATE resolved to no actual
 * change (it feeds `DeployResult.unchanged`), while `deleteSkipped` counts
 * DELETEs a provider refused to issue (issue #1762) — a resource that is
 * still alive and still in state.
 */
interface ProvisionCounts {
  created: number;
  updated: number;
  deleted: number;
  /** UPDATE resolved to no actual change — folded into `unchanged`. */
  skipped: number;
  /** Provider reported `{ outcome: 'skipped' }` for a template DELETE. */
  deleteSkipped: number;
  /**
   * Provider reported `{ outcome: 'partial' }` for an UPDATE (issue #1819) —
   * the resource WAS updated, but something the update owned survives and is
   * no longer in state. Counted apart from `updated` because the row is not a
   * clean success, and apart from `deleteSkipped` because the row's own
   * resource is not the thing that survived.
   */
  updatePartial: number;
}

/**
 * Deploy engine orchestrates the entire deployment process
 *
 * Responsibilities:
 * 1. Acquire stack lock
 * 2. Load current state
 * 3. Calculate diff
 * 4. Validate resource types
 * 5. Execute deployment in DAG order
 * 6. Save new state
 * 7. Release lock
 *
 * Rollback mechanism:
 * - Tracks completed operations during deployment
 * - On failure, rolls back in reverse order (best-effort)
 * - Supports --no-rollback flag to skip rollback (saves partial state and fails)
 * - CREATE → delete the newly created resource
 * - UPDATE → restore previous properties
 * - DELETE → cannot rollback (log warning)
 */
/**
 * Error thrown when the deployment is aborted mid-flight — by a user SIGINT
 * (Ctrl+C) or because another resource's failure cancelled the remaining
 * work. The two causes share one class (the engine's catch path treats them
 * identically) but carry cause-accurate messages: pending siblings cancelled
 * by a failure used to report "interrupted by user (Ctrl+C)" even though
 * nobody pressed anything.
 */
type InterruptCause = 'user' | 'sibling-failure';

class InterruptedError extends Error {
  constructor(reason: InterruptCause = 'user') {
    super(
      reason === 'user'
        ? 'Deployment interrupted by user (Ctrl+C)'
        : 'Deployment aborted after another resource failed'
    );
    this.name = 'InterruptedError';
  }
}

/**
 * The `imports` / `outputReads` records to persist on a save that is NOT the
 * final success save — the UNION of the pre-deploy snapshot and what THIS
 * session resolved (issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057) review).
 *
 * Every non-success save used to write `currentState.imports` /
 * `currentState.outputReads` verbatim, i.e. the PRE-DEPLOY snapshot, while
 * writing the POST-deploy `newResources` beside it. So a deploy that
 * introduced a cross-stack read and then failed persisted resources built FROM
 * that read next to a record that does not mention it. Two consequences, and
 * only the first is about #2057:
 *
 *  1. A rollback journal exists only after a FAILED deploy, so
 *     {@link producerRegionsFromState} saw an empty list on exactly the deploy
 *     that introduces a cross-region secret read — and
 *     `classifyReplaySecretRegion` answered `local`, resolving the producer's
 *     region-less expression in the consumer's region. The refusal was inert
 *     where it mattered most.
 *  2. INDEPENDENT PRE-EXISTING BUG. `state.imports[]` is what
 *     `findActiveImportConsumers` (`src/cli/commands/destroy-runner.ts`) scans
 *     to refuse destroying a producer while a consumer still imports from it,
 *     and `state.outputReads[]` is what `findDownstreamConsumers`
 *     (`src/cli/commands/recreate-downstream-consumers.ts`) enumerates. A
 *     failed deploy therefore silently DOWNGRADED a fresh strong reference to
 *     no reference: the consumer's resource is live and recorded, its import is
 *     not, and `cdkd destroy` on the producer sails through the strong-ref
 *     pre-flight. This exists on main today, with or without #2057.
 *
 * DIRECTION OF THE RESIDUAL, stated rather than left to be discovered: a union
 * never drops a record, so a stack that STOPS reading across a region keeps the
 * stale entry until its next SUCCESSFUL deploy, whose save replaces the list
 * wholesale (`imports: [...this.recordedImports]`). Until then a purely-local
 * rollback can be refused on the strength of a read the template no longer has.
 * That is the fail-closed side — a clear error naming the region to reconcile,
 * versus a silent wrong-secret write — and the same asymmetry already justifies
 * preserving the snapshot at all (dropping it would strip a live strong-ref
 * record on every diff-clean deploy).
 *
 * THE RULE IS "EVERY SAVE EXCEPT THE TERMINAL SUCCESS ONE", and it is stated
 * that way rather than as "every non-success save" because the latter is loose
 * in both directions: the diff-clean no-change save in `doDeploy` is a SUCCESS
 * outcome and unions anyway (nothing was re-resolved, so the union is an
 * identity there and one rule beats an exception), while
 * `persistStateAfterOutputFailure` looks like a success save — provisioning
 * was clean — and is not one.
 *
 * THE ENUMERATION IS NOT KEPT HERE, DELIBERATELY. Two prose counts in this
 * lane were measured wrong (an "ALL FIVE" that missed
 * `persistStateAfterOutputFailure`, and a "three post-rollback saves" that is
 * two), and each wrong count is worse than none: it is the sentence a reader
 * uses to conclude the rule is already applied everywhere.
 * `tests/unit/deployment/deploy-engine-cross-stack-read-writers.test.ts`
 * derives the set instead — it SCANS this file for every `imports:` /
 * `outputReads:` object key that writes a VALUE and fails on any that is not
 * the one allow-listed success-path write, with a positive control proving the
 * scan can see a violation. A save site added here fails that test rather than
 * escaping silently, so the authority on "where is this applied" is a grep the
 * test performs, not a number anybody has to maintain.
 */
export function crossStackReadsForPartialSave(
  previous: StackState,
  recordedImports: readonly StateImportEntry[],
  recordedOutputReads: readonly StateOutputReadEntry[],
  /**
   * Normalize a NAME for the identity key ONLY -- entries are still STORED
   * verbatim, the same compare-normalized / store-verbatim split this
   * function already makes for the region.
   *
   * Issue [#3289](https://github.com/go-to-k/cdkd/issues/3289) made it
   * necessary. `previous` is a persisted record, so its names are REDACTED;
   * `recorded` is this run's in-memory bag, so its names are PLAINTEXT. Keyed
   * raw, the two spellings of ONE reference carry different keys, both
   * survive the union, and `redactStateForPersist` then rewrites the
   * plaintext one into a byte-identical DUPLICATE -- a doubled row in the
   * destroy refusal and in the recreate prompt, on every deploy after the
   * first. Measured before this parameter existed; the union never drops, so
   * nothing downstream would have removed it.
   *
   * REQUIRED, not defaulted to identity. A default here would be a branch no
   * probe can red -- all seven call sites pass one, so nothing would exercise
   * it -- which is the shape this change already deleted an empty-bag arm for.
   * A caller holding no secrets gets identity from
   * `crossStackReadKeyNormalizer` itself, where the emptiness is DECIDED.
   */
  normalizeName: (name: string) => string
): Pick<StackState, 'imports' | 'outputReads'> {
  // The stack segment is normalized for `outputReads` and NOT for `imports`,
  // matching exactly which fields the persist redaction rewrites. Normalizing
  // both was tried and is wrong in the direction that DROPS a record:
  // `imports[].sourceStack` is stored verbatim forever, so normalizing it makes
  // the key space coarser than the value space -- two distinct producer names
  // whose plaintexts share one expression collapse onto one key, and the union
  // drops a genuinely distinct destroy-blocking import. That also contradicts
  // this change's own argument for leaving that field alone.
  //
  // ENCODED, not separated (go-to-k/cdkd#3496). `previous` comes from
  // persisted JSON that `parseState` only casts, so no half is guaranteed free
  // of a NUL. The old NUL-joined key could collide only when an entry's
  // STACK or REGION half carries a NUL (splitting at the first two NULs
  // recovers every field otherwise, whatever the name half holds). No
  // CDK-synthesized stack name or canonical region does; cdkd validates no
  // prebuilt-assembly stack-name charset, so only a hand-written assembly or a
  // hand-edited / corrupted record can. So this is defence against a MALFORMED
  // entry shadowing a genuine one, not a live fail-open: the union keeps the
  // first of two colliding entries, and `state.imports` is what
  // `destroy-runner` refuses a destroy on. `injectiveKey` cannot collide.
  const importKey = (e: StateImportEntry): string =>
    injectiveKey(e.sourceStack, canonicalizeRegion(e.sourceRegion), normalizeName(e.exportName));
  const outputReadKey = (e: StateOutputReadEntry): string =>
    injectiveKey(
      normalizeName(e.sourceStack),
      canonicalizeRegion(e.sourceRegion),
      normalizeName(e.outputName)
    );
  const imports = unionCrossStackReads(previous.imports, recordedImports, importKey);
  const outputReads = unionCrossStackReads(
    previous.outputReads,
    recordedOutputReads,
    outputReadKey
  );
  return {
    // Omitted rather than written empty, matching what every one of these save
    // sites did before: an absent field and an empty array are different
    // records to a reader that predates the field.
    ...(imports.length > 0 && { imports }),
    ...(outputReads.length > 0 && { outputReads }),
  };
}

/**
 * Concatenate two cross-stack-read lists, dropping a later duplicate of an
 * identity an earlier entry already carries. First-seen wins, so the PRE-DEPLOY
 * spelling of a region survives — entries are COMPARED on a canonicalized
 * region but STORED verbatim, mirroring `producerRegionsFromState`.
 */
function unionCrossStackReads<T>(
  previous: readonly T[] | undefined,
  recorded: readonly T[],
  identity: (entry: T) => string
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of [...(previous ?? []), ...recorded]) {
    // `previous` comes from persisted JSON, and `parseState` only CASTS — it
    // does not validate the element shape. A `null` / non-object element in a
    // hand-edited `state.imports` would make `identity` throw where the old
    // code copied the array verbatim. Every call site sits inside a try/catch
    // whose catch only warns, so the blast radius was a skipped save rather
    // than a crash, but a save skipped for this reason is a strong-reference
    // record silently not written.
    if (entry === null || typeof entry !== 'object') continue;
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export class DeployEngine {
  /** @internal */
  logger = getLogger().child('DeployEngine');
  /** @internal */
  resolver: IntrinsicFunctionResolver;
  /** @internal */
  interrupted = false;
  /**
   * Why `interrupted` was set — first cause wins. `'user'` = SIGINT;
   * `'sibling-failure'` = a resource failed and the remaining work is being
   * cancelled. Drives the {@link InterruptedError} message so cancelled
   * siblings don't misreport a Ctrl+C nobody pressed.
   */
  /** @internal */
  interruptCause: InterruptCause | null = null;

  /**
   * In-flight `provider.readCurrentState` promises kicked off after a
   * successful CREATE / UPDATE. The deploy critical path does NOT
   * `await` these; instead they're drained at the end of `doDeploy`
   * (success path only) and the resolved values are merged into
   * `ResourceState.observedProperties` before the final state save.
   *
   * Each Promise resolves to the AWS-current snapshot, or `undefined`
   * if the provider does not implement `readCurrentState` or the call
   * threw — never rejects, so an unhandled-rejection cannot escape.
   */
  /** @internal */
  observedCaptureTasks: Map<string, Promise<Record<string, unknown> | undefined>> = new Map();
  /**
   * The cap on the readback that decides a fresh-`NoEcho` replacement ceiling
   * (go-to-k/cdkd#3729). Outliving it keeps the replacement. A field rather
   * than a constant only so a test can shorten it.
   */
  /** @internal */
  noEchoCeilingReadbackTimeoutMs = 30_000;
  /**
   * The bags a masked-baseline re-capture produced (issue #3595). Each is the
   * PREVIOUS baseline with some masks replaced, already redacted, so
   * `drainObservedCaptures` installs it as it is rather than marking it as a
   * fresh readback. Keyed by the bag's identity, and mapped to the PREVIOUS
   * baseline it was built from: the drain installs it only while the record
   * still holds that very baseline, so a record this deploy rebuilt (an UPDATE
   * or a replacement whose provider takes no capture of its own) never
   * receives a bag describing the resource it replaced.
   */
  /** @internal */
  recapturedBaselines = new WeakMap<object, object>();
  /** @internal */
  stateBackend: S3StateBackend;
  /** @internal */
  lockManager: LockManager;
  /** @internal */
  dagBuilder: DagBuilder;
  /** @internal */
  diffCalculator: DiffCalculator;
  /** @internal */
  templateParser = new TemplateParser();
  /** @internal */
  providerRegistry: ProviderRegistry;
  /** @internal */
  options: DeployEngineOptions;
  /**
   * Optional persistent exports index store. When supplied, all
   * `Fn::ImportValue` resolutions in this deploy session prefer the
   * O(1) index lookup over the per-stack state.json scan, and the
   * consumer's `state.imports` field is populated for destroy-time
   * strong-reference checks. Shared across DeployEngine instances in
   * a single `cdkd deploy --all` invocation so the in-memory cache
   * survives across stacks.
   */
  /** @internal */
  exportIndexStore: ExportIndexStore | undefined;
  /**
   * Per-deploy-session bag the resolver pushes resolved
   * `Fn::ImportValue` entries into. Reset at the start of each
   * `deploy()` call and persisted to `newState.imports` at the end.
   */
  /** @internal */
  recordedImports: StateImportEntry[] = [];
  /**
   * Per-deploy-session bag the resolver pushes resolved
   * `Fn::GetStackOutput` entries into (schema v8+, issue #668).
   * Reset at the start of each `deploy()` call and persisted to
   * `newState.outputReads` at the end. Sibling of `recordedImports`
   * for the weak-reference `Fn::GetStackOutput` intrinsic.
   */
  /** @internal */
  recordedOutputReads: StateOutputReadEntry[] = [];
  /**
   * PER-RESOURCE map of resolved SECRET dynamic-reference values
   * (plaintext -> `{{resolve:...}}` expression) the resolver records for each
   * resource's own resolution (GHSA fix). Keyed by logicalId. Per-resource, NOT
   * session-wide, because a session-wide map cross-contaminates: if resource A
   * resolves a `{{resolve:...:SecretString}}` whole-secret reference to value V,
   * and resource B (e.g. the `AWS::SecretsManager::Secret` that OWNS the secret)
   * carries V as its own LITERAL property, a session-wide value scan would
   * wrongly rewrite B's literal to A's expression — a false positive that shows
   * up as a permanent spurious diff. Redacting each resource only with the
   * secrets substituted during ITS OWN resolution scopes the value match
   * correctly. Kept on the engine (not just the resolver context) so the async
   * observed-property capture — which drains after the context is gone — can
   * still redact an AWS-readback secret (Cognito `client_secret`). Reset per
   * `deploy()`. See `secret-redaction.ts`.
   */
  /** @internal */
  perResourceSecrets = new Map<string, RecordedSecretValues>();
  /**
   * Logical ids whose provider declared THIS RUN's `attributes` sensitive
   * (`ResourceCreateResult.noEchoAttributes` — issue
   * [#2274](https://github.com/go-to-k/cdkd/issues/2274)). One producer today:
   * `CustomResourceProvider`, relaying the handler's `NoEcho: true`.
   *
   * IN-RUN ONLY, and that is the whole shape of the feature rather than a
   * shortcut. `NoEcho` arrives on a RESPONSE, so cdkd knows it exactly when the
   * handler answered — this deploy — and `ResourceState` carries no durable
   * per-attribute flag to remember it by (a v9 -> v10 schema bump, issue
   * [#2449](https://github.com/go-to-k/cdkd/issues/2449)). Within the run that
   * is enough: the DAG provisions the custom resource before anything that
   * depends on it, so every dependent's resolution sees the entry. Across runs
   * the persisted `***` is the signal instead — see
   * `ResolverContext.redactedAttributeReads`.
   *
   * Reset per `deploy()`, like `perResourceSecrets`.
   *
   * `true` means the WHOLE attributes bag is sensitive (a custom resource's
   * `NoEcho` response); a SET names the sensitive members only (a nested
   * stack's `Outputs.<Key>` entries — see `NoEchoAttributesResult`).
   */
  /** @internal */
  noEchoAttributeResources = new Map<string, true | ReadonlySet<string>>();
  /**
   * PER-RESOURCE unresolved TEMPLATE properties, keyed by logicalId (issues
   * #1904 / #1900). The redaction choke point uses this as the POSITION source:
   * wherever the template leaf is a `{{resolve:...}}` string, state persists
   * that string verbatim instead of asking the value-keyed map which expression
   * a plaintext came from — a question that map cannot answer when two
   * expressions resolve to the same value. Captured at the same two sites that
   * populate `perResourceSecrets`, where the unresolved bag is already in hand.
   * Reset per `deploy()`.
   */
  /** @internal */
  perResourceTemplateProps = new Map<string, Record<string, unknown>>();

  /**
   * The resource TYPE each logical id was resolved as during THIS deploy
   * (issue #2934), the sibling of {@link perResourceSecrets} and
   * {@link perResourceTemplateProps}.
   *
   * Exists only so the orphan-record redaction can tell "these needles belong
   * to this record" from "a CDK refactor reused this logical id for a different
   * resource". Keying that on `state.resources` instead was tried and is WRONG
   * in the direction that matters: an orphan is by definition NOT in
   * `resources`, so the gate read false for the record being minted, the
   * needles went empty, and the plaintext survived into `state.json`. The
   * real-AWS secret fixture caught it.
   */
  /** @internal */
  perResourceResolvedType = new Map<string, string>();
  /**
   * Resolved secrets recorded while resolving the stack OUTPUTS (a `CfnOutput`
   * whose Value resolves a `{{resolve:...}}` reference). Separate from the
   * per-resource maps for the same anti-cross-contamination reason. Reset per
   * `deploy()`.
   */
  /** @internal */
  outputSecrets: RecordedSecretValues = new Map();
  /**
   * The outputs pass's own recording map(s), one per `resolveOutputs` call
   * this deploy, so every redaction of the outputs bag re-reads them rather
   * than trusting the copy taken when the pass ended (issue
   * [#2814](https://github.com/go-to-k/cdkd/issues/2814)): a part the drain
   * cap stopped waiting for records into its pass map LATE, and the final
   * save, the exports index and the deploy summary all run after that copy.
   * Reset per `deploy()`.
   */
  /** @internal */
  outputsPassSecretMaps: RecordedSecretValues[] = [];
  /**
   * UNRESOLVED template `Outputs` values, keyed by output name (issue #1910) —
   * the outputs' POSITION source, the sibling of `perResourceTemplateProps` for
   * the bag `resolveOutputs` produces. Without it two outputs resolving one
   * secret collapse onto whichever expression was recorded last, exactly as two
   * resource properties did before #1904. Captured in `resolveOutputs` at the
   * same point `outputSecrets` is accumulated. Reset per `deploy()`.
   *
   * Null-prototype for the same reason as the outputs bag `resolveOutputs`
   * builds two lines away: both are keyed by TEMPLATE-CONTROLLED output names,
   * so an output called `__proto__` would replace this bag's prototype and a
   * later lookup of a name it never stored would inherit from it. Only the
   * RESET in `deploy()` is pinned — reverting this initialiser alone survives
   * the suite, measured, because `deploy()` replaces the bag before anything
   * writes to it, so the initialiser matches the reset rather than standing as
   * a second guard.
   */
  /** @internal */
  outputsTemplateSource: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  /**
   * The export aliases the last `resolveOutputs` pass WROTE into its bag
   * (issue #2193) — exactly the keys `outputs[exportName] = value` landed on,
   * so an alias the pass refused (secret-bearing name, collision with a
   * published output name) or skipped (unresolved value, condition-suppressed
   * output) is not in it. Persisted as `StackState.exportNames` by the saves
   * that persist that bag, and the set the exports index is fed from. Reset
   * at the top of every `resolveOutputs`, so it is only meaningful right
   * after that call returns — read it there, not later.
   */
  /** @internal */
  resolvedExportNames: string[] = [];
  /**
   * The outputs the last `resolveOutputs` pass could NOT resolve and SKIPPED
   * (the resolver threw under the default arm of
   * `handleOutputResolutionFailure`, or returned `undefined` outright without
   * `--strict-getatt` — see
   * `collectSkippedOutputs`), each mapped to the
   * digest `cdkd diff` compares against (issue #2740, `StackState.
   * skippedOutputs`). `undefined` when nothing was skipped, so the saves that
   * persist the resolved bag spread it as-is and the field stays omitted. Same
   * lifetime rule as `resolvedExportNames`: reset at the top of every
   * `resolveOutputs`, meaningful only right after that call returns.
   */
  /** @internal */
  skippedOutputs: Record<string, string> | undefined;
  /**
   * Whether {@link outputsTemplateSource} may be used to POSITION the outputs
   * redaction. False once an outputs pass threw partway: the post-loop
   * name pass never ran, so the bag holds only the alias keys written before
   * the throw — a partial source built from THIS template, while the bag the
   * failure path then redacts is the PREVIOUS deploy's. Reset per `deploy()`.
   */
  /** @internal */
  outputsSourceUsable = true;

  /**
   * Per-logical-id snapshot of the intrinsic-RESOLVED desired properties
   * each CREATE / UPDATE attempted (issue #1198). Written just before the
   * provider call; read only when the op FAILS, to journal the failed op's
   * `attemptedProperties` so `cdkd rollback --revert-failed` can generate a
   * patch that undoes a half-applied update.
   */
  /** @internal */
  attemptedResolvedProps = new Map<string, Record<string, unknown>>();

  /**
   * The live-progress label `provisionResource` gave each resource, and whether
   * its verb said `Replacing` (go-to-k/cdkd#3662). The label is chosen before
   * resolution, so a resource whose only replacement is a CEILING (a synthetic
   * change, see `isReplacementCeiling`) is labelled `Updating`; the UPDATE arm
   * re-labels it here if the resolved value keeps the replacement, and the
   * slow-resource warning reads the current label rather than the first one.
   */
  /** @internal */
  liveTaskLabels = new Map<string, { label: string; replacing: boolean; warnSuffix?: string }>();

  /**
   * Logical ids whose replacement this deploy DELIBERATELY left the old
   * physical resource alive for — `UpdateReplacePolicy: Retain` (issue
   * [#2603](https://github.com/go-to-k/cdkd/issues/2603)).
   *
   * Written by every engine path that skips the post-replacement delete, read
   * once at the `completedOperations.push` site to stamp
   * {@link CompletedOperation.oldResourceRetained}. It exists because the
   * rollback classifier used to re-derive the verdict from
   * `previousState.updateReplacePolicy` — a DIFFERENT source than the
   * template read the engine decides from — so the two disagreed on exactly
   * the deploy that changes the attribute, in both directions:
   *
   *   - ADDING `Retain`: the deploy orphans the old resource while the
   *     previous state record carries no policy, so the rollback re-CREATED a
   *     resource that is still alive (a duplicate for an auto-named type, an
   *     `AlreadyExists` failure for a user-named one).
   *   - DROPPING `Retain`: state still carries the stale `Retain`, the
   *     template omits it so the deploy correctly DELETES the old resource,
   *     and the rollback then re-adopted a physical id that no longer exists,
   *     leaving state naming a deleted resource.
   *
   * Records only the DELIBERATE retention. A best-effort cleanup delete that
   * FAILED, was SKIPPED, or was blocked by a failed final snapshot also leaves
   * the old resource alive, but the deploy does not KNOW it survived — those
   * stay `false` and keep today's `reverse-replacement` behaviour rather than
   * having the rollback re-adopt an id it cannot vouch for (issue
   * [#2631](https://github.com/go-to-k/cdkd/issues/2631)).
   *
   * Cleared per `deploy()` alongside the other per-run maps: a `false` here
   * must mean "this deploy deleted it", never "a previous run said so".
   */
  /** @internal */
  retainedOldOnReplacement = new Set<string>();

  /**
   * The pre-deploy state records, as loaded — the #1852 heal's eligibility
   * baseline. A record is healed only while it is still the one this deploy
   * LOADED (same physical id, same `attributes` object): once a provider has
   * (re)written it this run, a missing attribute is the provider's answer, not
   * staleness, and re-reading would cost an AWS call to learn nothing.
   *
   * Compared by the `attributes` REFERENCE rather than the record's, because
   * the metadata-only arm re-spreads a record (`{ ...currentResource }`) without
   * a provider call — its attributes object survives the spread, a create /
   * update result's does not.
   */
  /** @internal */
  healBaseline: Readonly<Record<string, ResourceState>> = {};
  /**
   * go-to-k/cdkd#4156: this deploy's diff, read by `inlinePolicyClaimedFor` to
   * tell whether a principal's completed update put its `Policies`.
   * Per-deploy, like `healBaseline`.
   */
  private deployChanges: ReadonlyMap<string, ResourceChange> = new Map();
  /**
   * go-to-k/cdkd#4156: the resources whose provider create / update
   * COMPLETED in this deploy, recorded right after their state record is
   * written. Per-deploy, like `healBaseline`.
   */
  private inlinePolicyWriters = new Map<string, InlinePolicyWrite>();

  /**
   * Single-flight + per-deploy memo of the #1852 heal, keyed by logical id and
   * physical id. ENGINE-instance state, never module-global: one engine deploys
   * one stack, and `--stack-concurrency` runs several engines at once. Holding
   * the PROMISE is what makes it single-flight — every concurrent resolution of
   * the same record awaits the one read — and never deleting an entry is what
   * bounds it: one read per record per deploy, success or failure, no retry.
   */
  /** @internal */
  attributeHeals = new Map<string, Promise<StaleAttributeHealOutcome>>();

  /**
   * What the heals of this deploy read, waiting for the next state save.
   *
   * Applied at {@link redactStateForPersist} — the choke point EVERY save
   * passes through — rather than written into the in-memory record, so a heal
   * survives every exit path that saves at all (success, a failed resource, a
   * failed output, the no-change path), whichever copy-on-write record map the
   * save happens to hold, and is scrubbed by the same redaction every other
   * attribute goes through. A path that saves NOTHING (`--dry-run`) persists
   * nothing and the next deploy re-heals.
   */
  /** @internal */
  healedAttributes = new Map<
    string,
    { physicalId: string; resourceType: string; attributes: Record<string, unknown> }
  >();

  /**
   * Target region for this stack. Required — load-bearing for the
   * region-prefixed S3 state key and recorded in state.json for
   * cross-region destroy.
   */
  /** @internal */
  stackRegion: string;

  constructor(
    stateBackend: S3StateBackend,
    lockManager: LockManager,
    dagBuilder: DagBuilder,
    diffCalculator: DiffCalculator,
    providerRegistry: ProviderRegistry,
    options: DeployEngineOptions = {},
    stackRegion: string,
    exportIndexStore?: ExportIndexStore
  ) {
    this.stateBackend = stateBackend;
    this.lockManager = lockManager;
    this.dagBuilder = dagBuilder;
    this.diffCalculator = diffCalculator;
    this.providerRegistry = providerRegistry;
    this.options = options;
    this.stackRegion = stackRegion;
    this.exportIndexStore = exportIndexStore;
    this.resolver = new IntrinsicFunctionResolver(stackRegion, {
      strictGetAtt: options.strictGetAtt ?? false,
      cfnFallback: options.cfnFallback ?? true,
    });
    this.options.concurrency = options.concurrency ?? 10;
    this.options.dryRun = options.dryRun ?? false;
    this.options.lockTimeout = options.lockTimeout ?? 5 * 60 * 1000; // 5 minutes
    this.options.noRollback = options.noRollback ?? false;
    this.options.resourceWarnAfterMs =
      options.resourceWarnAfterMs ?? DEFAULT_RESOURCE_WARN_AFTER_MS;
    this.options.resourceTimeoutMs = options.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
    // Default ON: drift detection without observedProperties is the
    // pre-PR behavior and we want the upgrade to be a strict superset.
    // The opt-out exists for users who care more about deploy speed
    // than the +0-10% drift-baseline overhead.
    this.options.captureObservedState = options.captureObservedState ?? true;
  }

  /**
   * Deploy a CloudFormation template
   */
  async deploy(stackName: string, template: CloudFormationTemplate): Promise<DeployResult> {
    // Reset per-session state. `recordedImports` is the bag the
    // resolver pushes Fn::ImportValue resolutions into; it lands in
    // `state.imports` at deploy save time. `recordedOutputReads`
    // is the v8 sibling for Fn::GetStackOutput, landing in
    // `state.outputReads`.
    this.recordedImports = [];
    this.recordedOutputReads = [];
    this.perResourceSecrets = new Map();
    this.noEchoAttributeResources = new Map();
    this.perResourceTemplateProps = new Map();
    // Reset with its siblings (issue #2934). Inert today — a stale TRUE pairs
    // with cleared needle maps and reduces to the identity fallback — but this
    // map's whole job is to answer "do those needles describe THIS record",
    // and a reused engine carrying last deploy's answer is the #2516 class.
    this.perResourceResolvedType = new Map();
    // Issue #2516: reset with the other per-deploy maps. A reused engine
    // whose next deploy fails before its own attempted bag is recorded would
    // otherwise journal the PREVIOUS run's bag against today's template and
    // pairs — and now mark it as today's.
    this.attemptedResolvedProps = new Map();
    this.liveTaskLabels = new Map();
    this.outputSecrets = new Map();
    this.outputsPassSecretMaps = [];
    // Null-prototype for the same reason as the outputs bag it positions
    // (issue #1943's class, and #2740's `__proto__` case): both are keyed by
    // TEMPLATE-CONTROLLED output names two lines apart, so an output literally
    // named `__proto__` would replace this bag's prototype and a later lookup
    // of an output named, say, `Fn::GetAtt` would inherit a value from it.
    // The pair was inconsistent inside one function, which is the state a
    // later reader has to re-derive.
    this.outputsTemplateSource = Object.create(null) as Record<string, unknown>;
    this.outputsSourceUsable = true;
    // Issue #2740, same reuse hazard as `retainedOldOnReplacement` below.
    // The ONLY reset for this field: `resolveOutputs` recomputes it at the
    // END of a pass, but early-returns for a template with no `Outputs`
    // without touching it, so a reused engine would otherwise carry the
    // PREVIOUS deploy's record into that run. A second reset inside
    // `resolveOutputs` would mask this one — neither could then be pinned —
    // so the clearing lives here, with the other per-run bags.
    this.skippedOutputs = undefined;
    // Issue #2603: an engine can be reused across deploys, and a STALE `true`
    // here would tell the next run's rollback to re-adopt an id this run
    // deleted. Reset in the same block as the other per-run bags.
    this.retainedOldOnReplacement = new Set();
    // Issue #1852: per-deploy, like every bag above — a reused engine must not
    // serve last deploy's read, nor persist it against today's records.
    this.healBaseline = {};
    this.deployChanges = new Map();
    this.inlinePolicyWriters = new Map();
    this.attributeHeals = new Map();
    this.healedAttributes = new Map();
    // Per-deploy-run counter: the resolver instance is engine-scoped and an
    // engine can be reused across deploys, so reset here (not in the
    // resolver constructor) to keep the deploy-summary count per run.
    this.resolver.resetPhysicalIdFallbackCount();
    // Scope `stackName` to this deploy's async chain so concurrent
    // deploys (--stack-concurrency > 1) don't see each other's value.
    // See `src/provisioning/resource-name.ts` for the AsyncLocalStorage
    // background.
    return withStackName(stackName, () => this.doDeploy(stackName, template));
  }

  /**
   * Resolver context with the imports-recording and exports-index
   * fields wired in. Keeps the four+ inline context construction
   * sites consistent — pass through callable as
   * `this.buildResolverContext({...}, stackName)`.
   */
  /** @internal */
  buildResolverContext(
    base: {
      template: CloudFormationTemplate;
      resources: Record<string, ResourceState>;
      parameters?: Record<string, unknown>;
      conditions?: Record<string, boolean>;
      /**
       * The masked-read bag, supplied by the CALLER and only by a caller that
       * READS it (issue #2847 round-4 review). Absent means the resolver serves
       * the mask exactly as `main` does.
       *
       * It used to be set here on EVERY context this method builds, on the
       * argument that an array nobody consults costs nothing and that omitting
       * it would leave a future provisioning site silently unguarded. The first
       * half stopped being true when `resolveRefValue` began deciding the
       * masked-leaf SKIP from the bag's PRESENCE: on the deploy-internal DIFF
       * context — which has no refusal reader — the skip fired anyway, so
       * `{Ref: X}` resolved to the raw physical id and was compared against the
       * `'***'` in state. Measured on a pre-existing issue #2274 stack (a
       * `NoEcho` value in `properties.TableName`, a sibling `{Ref: Tbl}`):
       * NO_CHANGE and a clean deploy on `main`, a spurious UPDATE and then a
       * hard failure at the provisioning refusal with the bag present. Fail-
       * closed, so never an exposure — but a regression for existing users and
       * a divergence from standalone `cdkd diff`, which is bagless and still
       * reports NO_CHANGE.
       *
       * The second half is answered by making the decision VISIBLE instead of
       * ambient: a provisioning site that wants the guard passes the bag on the
       * line where it builds its context, and
       * `tests/unit/deployment/deploy-engine-resolver-context-bag-scope.test.ts`
       * asserts which sites do.
       */
      redactedAttributeReads?: RedactedAttributeRead[];
    },
    stackName: string
  ): import('./intrinsic-function-resolver.js').ResolverContext {
    // FRESH per-context map — see the field note at the bottom of the returned
    // object. Named here rather than inlined so the nested-stack parameter
    // associations can be copied onto it (issue #2291).
    const recordedSecretValues = new Map<string, string>();
    // Issue #2291: the parent recorded, per child PARAMETER NAME, which
    // `{{resolve:...}}` expression that parameter was resolved from. Copy those
    // onto this resource's bag as `{Ref: <ParamName>}` position associations,
    // so a child leaf spelling the parameter persists ITS OWN expression rather
    // than whichever one the plaintext-keyed inherited map kept.
    //
    // NOT the issue #2087 pre-seed this file's note below warns about, and the
    // difference is which store decides SCOPE. That defect pre-loaded the
    // PLAINTEXT map, which is what `redactSecretsForState` substring-matches
    // with — so every resource's literals became rewritable. These associations
    // can only change an answer for a leaf whose value is already a plaintext in
    // THIS bag, i.e. only for a resource whose own resolution consumed the
    // parameter. They decide WHICH expression such a leaf takes, never WHETHER
    // a leaf is rewritten.
    if (this.options.inheritedSecrets && this.options.inheritedSecrets.size > 0) {
      inheritNestedStackParameterAssociations(recordedSecretValues, this.options.inheritedSecrets);
    }
    return {
      template: base.template,
      resources: base.resources,
      ...(base.parameters &&
        Object.keys(base.parameters).length > 0 && { parameters: base.parameters }),
      ...(base.conditions &&
        Object.keys(base.conditions).length > 0 && { conditions: base.conditions }),
      stateBackend: this.stateBackend,
      stackName,
      ...(this.exportIndexStore && { exportIndex: this.exportIndexStore }),
      recordedImports: this.recordedImports,
      recordedOutputReads: this.recordedOutputReads,
      // Issue #1852: on EVERY context this engine builds — the diff pass, both
      // provisioning arms and the outputs pass all read the same stale record,
      // and the heal is memoized, so whichever asks first pays the one read.
      attributeHealer: (logicalId, resource) =>
        this.healStaleAttributes(logicalId, resource, stackName),
      // The pairs the PARENT resolved for this stack, on a nested-stack child
      // engine only (issue #1903). NOT pre-loaded into the map below: the
      // resolver copies a pair across at the moment a resource's `{Ref: Param}`
      // actually resolves to a value carrying that plaintext
      // (`recordInheritedParameterSecrets`), so the pair lands in the bag of
      // the resource that consumed the parameter and nowhere else.
      //
      // The first cut DID pre-load every context's map, and that was issue
      // #2087: `redactSecretsForState` substring-matches at or above
      // `MIN_NEEDLE_LENGTH`, so a child resource that never referenced the
      // parameter but spells `my-production-bucket` while the secret is
      // `production` had `my-{{resolve:...}}-bucket` persisted. The desired
      // side does NOT mirror that — `redactParametersForDiff` rewrites only the
      // PARAMETERS — so the stack acquired a perpetual UPDATE, or a perpetual
      // REPLACEMENT on a create-only property. The rationale that shipped with
      // it ("the same over-approximation the parent already accepts") was
      // simply wrong: the parent scopes its bag to the ONE resource whose
      // resolution produced the secret, because `perResourceSecrets` is keyed
      // by logical id. Recording at resolution time gives the child the SAME
      // scoping rule.
      //
      // PARITY, not perfection, and the residual is worth naming rather than
      // leaving to be rediscovered: within a resource that genuinely DOES
      // consume the parameter, `redactSecretsForState` still substring-matches
      // every leaf, so an UNRELATED literal in that same resource carrying the
      // plaintext verbatim is rewritten too. The parent has exactly that
      // residual for a resource that resolves a `{{resolve:...}}`, so this is
      // the child reaching parity with it — not a claim that no
      // over-approximation remains.
      //
      // `hasMaskableValues`, not `size` (go-to-k/cdkd#1998): a parent bag
      // holding only LOG-ONLY needles (a `NoEcho` parameter's value) must still
      // reach the child's resolver, which masks with it and carries it into the
      // bag of the child resource consuming the parameter. Every reader of
      // this field that PERSISTS or positions still asks `size` itself.
      ...(this.options.inheritedSecrets &&
        hasMaskableValues(this.options.inheritedSecrets) && {
          inheritedSecrets: this.options.inheritedSecrets,
        }),
      // FRESH per-context map: the resolver records each resolved secret
      // (plaintext -> `{{resolve:...}}` expression) here (GHSA fix). The caller
      // captures it and stores it per-logicalId in `perResourceSecrets` (or in
      // `outputSecrets` for the outputs pass) so each bag is redacted only with
      // the secrets substituted during ITS OWN resolution — see the
      // `perResourceSecrets` field doc for why per-resource, not session-wide.
      recordedSecretValues,
      // Issue #2274. `noEchoAttributeResources` goes on EVERY context this
      // method builds — the diff / no-op one included — because it can only ADD
      // mask-only needles to a bag, which is right wherever that bag ends up
      // redacting something and inert wherever it does not.
      //
      // `redactedAttributeReads` is the opposite and comes from the CALLER: it
      // is an OPT-IN whose presence changes what the resolver SERVES, so it
      // belongs only where a reader exists. The `base` field's own doc carries
      // the measurement that forced the split.
      noEchoAttributeResources: this.noEchoAttributeResources,
      ...(base.redactedAttributeReads && {
        redactedAttributeReads: base.redactedAttributeReads,
      }),
    };
  }

  /**
   * The printing masker the diff calculator's log lines take
   * (go-to-k/cdkd#4049): the diff pass's own bag, every `NoEcho` parameter's
   * value, then a nested child's inherited bag. The diff bag is bound by
   * reference, so a needle the pass records after this call is masked too.
   *
   * The parameter values are recorded HERE, up front, into a bag of this
   * masker's own: the diff records a value only when a `Ref` serves it, in
   * template order, so a resource whose property STOPPED reading the
   * parameter would otherwise print its old value from state whenever the
   * parameter's other readers come later in the template, or none remain.
   * Never the diff bag: nothing but this printer reads it.
   *
   * ONE pass over the union (`createUnionSecretMasker`): a pass per bag let
   * one bag's shorter needle cut a longer needle another bag held and print
   * the rest of it.
   */
  private diffLogMasker(
    diffSecrets: RecordedSecretValues | undefined,
    template: CloudFormationTemplate,
    parameterValues: Record<string, unknown>
  ): SecretMasker {
    const inherited = this.options.inheritedSecrets;
    const noEchoValues: RecordedSecretValues = new Map();
    // The pieces of every literal `Fn::Split` over a `NoEcho` value too
    // (go-to-k/cdkd#4049), for a property that stopped reading one.
    const noEchoNames = new Set(
      Object.entries(template.Parameters ?? {})
        .filter(([, definition]) => definition?.NoEcho === true)
        .map(([name]) => name)
    );
    const splitDelimiters = literalSplitDelimitersOf(template, noEchoNames);
    for (const [name, definition] of Object.entries(template.Parameters ?? {})) {
      if (definition?.NoEcho === true && Object.hasOwn(parameterValues, name)) {
        recordLogOnlyParameterValue(noEchoValues, parameterValues[name], splitDelimiters);
      }
    }
    return createUnionSecretMasker([diffSecrets, noEchoValues, inherited]);
  }

  /**
   * The names of this child's parameters whose value carries a `NoEcho` value
   * the parent supplied in THIS deploy (go-to-k/cdkd#3717), read off the
   * inherited bag's fresh marks. `undefined` outside a nested child, or when
   * none does.
   *
   * A parameter that EMBEDS such a value (`prefix-<token>`) counts too: the
   * containment arm masks that leaf whole (go-to-k/cdkd#2453), and
   * `carriesFreshNoEchoValue` shares its predicate.
   */
  private freshNoEchoParameters(
    parameterValues: Record<string, unknown>
  ): ReadonlySet<string> | undefined {
    const inherited = this.options.inheritedSecrets;
    if (!inherited || inherited.size === 0) return undefined;
    const fresh = new Set<string>();
    for (const [name, value] of Object.entries(parameterValues)) {
      if (carriesFreshNoEchoValue(value, inherited)) fresh.add(name);
    }
    return fresh.size > 0 ? fresh : undefined;
  }

  /**
   * The parameter bag the DIFF resolver context binds, with any inherited
   * secret plaintext rewritten back to its `{{resolve:...}}` expression (issue
   * #1903).
   *
   * The provisioning pass must keep the REAL values — that is what actually
   * reaches AWS — but the child's persisted state holds the expression, so the
   * comparison side has to hold it too or every deploy of a secret-bearing
   * nested stack reports a spurious UPDATE and re-issues an AWS call that
   * changes nothing. This is the child-stack twin of the
   * `skipDynamicReferences` flag the parent's own diff sets: same goal
   * (expression-vs-expression), reached differently because the child's
   * template carries `{Ref: Param}` rather than a `{{resolve:` string, so
   * there is no reference for that flag to decline to resolve.
   *
   * `redactSecretsForState` rather than a `Map.get` lookup so an EMBEDDED
   * secret — a parameter whose value is `postgres://u:<secret>@host` because
   * the parent built it with `Fn::Sub` — is rewritten the same way the
   * state-save choke point rewrites it, keeping the two sides byte-identical.
   * Identity-returns when nothing was inherited.
   */
  private redactParametersForDiff(
    parameterValues: Record<string, unknown>
  ): Record<string, unknown> {
    const inherited = this.options.inheritedSecrets;
    if (!inherited || inherited.size === 0) return parameterValues;
    // `Object.create(null)` (issue #2802). Since the resolver's parameters bag
    // became null-prototype, a template parameter named `__proto__` is a real
    // OWN key here rather than one already swallowed upstream -- so a plain
    // `{}` accumulator would drop it through the inherited setter and move the
    // very defect the sweep fixed one hop downstream, into a file the checker
    // does not scan.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [name, value] of Object.entries(parameterValues)) {
      // Issue #2291: the PER-PARAMETER answer first, because `inherited` is
      // keyed by PLAINTEXT and two parameters resolving to one value have
      // already collapsed there. The persist side positions each child leaf
      // onto its OWN expression; without the same answer here the losing
      // parameter's desired side would carry the SURVIVOR's expression forever
      // and its resource would report a spurious UPDATE on every deploy.
      // `undefined` whenever the parent could not certify one, which falls back
      // to the value scan below — the pre-#2291 behaviour, expression-collapsed
      // but consistent with what a pre-#2291 persist side wrote.
      out[name] =
        inheritedParameterExpression(inherited, name, value) ??
        redactSecretsForState(value, inherited);
    }
    return out;
  }

  /**
   * Redact resolved secret plaintext out of a bag about to be PERSISTED to
   * state, replacing each secret value with the unresolved `{{resolve:...}}`
   * expression it came from (GHSA fix; see `secret-redaction.ts`). No-op when
   * the deploy recorded no secrets. The bag sent to the AWS API is the
   * un-redacted resolved bag; only the persisted copy is rewritten.
   */
  /**
   * Redact the resolved stack OUTPUTS bag, positioned by the unresolved
   * template `Outputs` values (issue #1910).
   *
   * A single entry point because SEVEN call sites redact this same bag — the
   * state-persist choke point, the no-change re-check, that path's exports
   * index and deploy summary, the changes path's index and summary, and the
   * outputs pass itself. THREE of those are the ones issue #1910 unified —
   * the persist choke point, the re-check, and the outputs pass, which the
   * list above ends on rather than opens with: before it they each spelled
   * the value-only redaction separately, and two outputs resolving one secret
   * collapsed onto whichever expression was recorded last at all three. The
   * other FOUR are issue #2814's, both paths' index and summary: each read
   * the bag unredacted until then, and now redacts at the moment it reads.
   */
  /**
   * Record the plaintext behind every output {@link redactOutputs} just masked,
   * for the duration of THIS PROCESS (issue #2274).
   *
   * Per KEY, comparing the two bags rather than re-deriving from the secrets
   * map: what matters is whether the persisted value at this key IS a mask that
   * the resolved value was not, which is exactly "this key's plaintext is about
   * to become unreadable". A key already carrying `***` before redaction — a
   * value read back out of a previous run's state — is skipped, because there
   * is no plaintext behind it to remember.
   *
   * Called only from the REAL-DEPLOY outputs pass. Of the six other
   * `redactOutputs` callers, three CAN hand it a bag from a previous
   * generation — the persist walk always may, and the no-change path's
   * exports index and summary do on the arms where that path keeps the
   * previous bag — and there a mask is already unrecoverable, so pretending
   * otherwise would
   * serve a stale value. The other three are not this pass either: the
   * no-change path performs the FIRST redaction of its own resolution there,
   * and the changes path's index and summary re-redact the bag this pass
   * already produced. (The "other two" this replaces counted the base's three
   * callers correctly; what was wrong was calling both of the others
   * previous-generation, when only the persist walk was one.)
   */
  private rememberRecoverableMaskedOutputs(
    stackName: string,
    resolved: Record<string, unknown>,
    redacted: Record<string, unknown>
  ): void {
    if (resolved === redacted) return;
    // Recorded UNDER the identity that produced it (go-to-k/cdkd#3691): the
    // readers compute the same fingerprint from the clients they resolve with,
    // so another identity's same-named stack in this process misses.
    const identity = credentialFingerprint(ambientCredentialConfig());
    for (const [key, redactedValue] of Object.entries(redacted)) {
      if (!carriesSecretMask(redactedValue)) continue;
      const plaintext = resolved[key];
      if (plaintext === undefined || carriesSecretMask(plaintext)) continue;
      recordRecoverableMaskedOutput(identity, stackName, this.stackRegion, key, plaintext);
    }
  }

  /**
   * Fold every outputs-pass recording map into `outputSecrets` — the entries,
   * and the uncollapsed evidence beside them (issue #2485: without it a
   * literal Output embedding one of two same-plaintext references would lose
   * its span positioning and persist the sibling's expression). Only what the
   * outputs pass itself resolved, so the outputs redaction (GHSA fix) uses
   * only outputs-substituted references: a literal output equal to a secret
   * nothing resolved is not recorded, and is not touched.
   *
   * Run by every {@link redactOutputs}, AND by
   * {@link crossStackReadKeyNormalizer} (issue
   * [#3289](https://github.com/go-to-k/cdkd/issues/3289)), which needs the
   * same bag and runs BEFORE the persist walk. Calling it twice in one save
   * is safe and MEASURED rather than assumed: the entry fold re-sets equal
   * values, and `recordResolvedPair` leaves a pair alone when the plaintext
   * is unchanged, so no CONFLICTING marker is invented. (issue
   * [#2814](https://github.com/go-to-k/cdkd/issues/2814)), because a part the
   * drain cap stopped waiting for records into its pass map LATE: a secret
   * that arrives between the pass and the final save is then still a needle
   * for the save, the exports index and the deploy summary. Repeating it is
   * safe for the ENTRIES — re-setting one the bag holds changes nothing, and
   * `Map.set` on an existing key keeps its insertion order, so last-wins
   * cannot be reordered by a refold.
   *
   * The PAIRS are where repeating is not merely a no-op, stated because the
   * end-of-pass copy could not see it: a part the cap stopped waiting for can
   * record a pair LATE, and a second value for one expression marks it
   * `CONFLICTING_PLAINTEXT` (a non-cacheable `{{resolve:ssm:X}}` re-resolved
   * to a moved value). A later refold then carries that conflict into
   * `outputSecrets`, the leaf loses its positioning and falls to the value
   * scan, which can persist a sibling's expression (the issue #2485 class).
   * The plaintext stays MASKED either way, so the cost is which expression
   * is stored, not a disclosure — and the alternative, dropping the late
   * pair, would keep a positioning the pass itself no longer vouches for.
   */
  private absorbOutputsPassSecrets(): void {
    for (const passSecrets of this.outputsPassSecretMaps) {
      for (const [value, expr] of passSecrets) {
        this.outputSecrets.set(value, expr);
      }
      mergeResolvedPairs(passSecrets, this.outputSecrets);
    }
  }

  /**
   * Redact the outputs bag. NOT a pure transform: it folds the outputs pass
   * map into `outputSecrets` first (issue #2814), so every call can grow that
   * bag. Its KEY set only grows, and the bag has no other reader, which is
   * what makes calling this on every save, index write and summary safe. The
   * resolved PAIRS beside those keys are not equally free to refold — see
   * {@link absorbOutputsPassSecrets}, which states what a late one costs.
   */
  private redactOutputs(outputs: Record<string, unknown>): Record<string, unknown> {
    // First, and before the empty-bag return: a late recording (issue #2814)
    // may be the only needle there is.
    this.absorbOutputsPassSecrets();
    if (this.outputSecrets.size === 0) return outputs;
    // TEMPLATE_SOURCED and not the DEFAULT template-DERIVED rules (issue
    // [#1943](https://github.com/go-to-k/cdkd/issues/1943)). `descendArrays` is
    // the only flag the two differ on, and it claims "this bag was PRODUCED by
    // resolving this source" — which several of its callers cannot say:
    // `redactStateForPersist`, the no-change path's exports index and summary,
    // and that path's save-time mixed-generation check over a MERGED bag (issue
    // #2771). (Issue #2814 took the callers from three to seven, and the "two" was already
    // wrong before it — of the base's three sites only the persist walk took
    // a foreign bag.) `redactStateForPersist` walks whatever `state.outputs`
    // holds, and on
    // the no-change path that is `persistedOutputs`, the PREVIOUS deploy's bag,
    // while `outputsTemplateSource` is TODAY's template. Positional descent
    // there does not merely mis-redact: `redactByPath` returns a known-secret
    // SOURCE leaf verbatim, so a previous generation's ordinary literal at
    // index `i` is rewritten to today's expression at index `i` — a value the
    // stack never held, persisted into `state.outputs`, which the exports index
    // re-applies to consumer stacks.
    //
    // Reachable rather than theoretical, though narrowly: `TemplateOutput.Value`
    // is `unknown` and cdkd does not enforce CloudFormation's "Value must be a
    // String", so a list-valued output (an escape hatch, an imported template)
    // gives the array arm an array on BOTH sides and `state.outputs` is
    // explicitly not string-coerced. Every CDK-synthesized template lands on a
    // string or an intrinsic OBJECT, so for those the swap is inert.
    //
    // `sourceIsSameGeneration` is already false in both constants, so the
    // token-shaped-leaf hazard (issue #1917) was never the gap here. The
    // sibling `cdkd scrub` outputs call still passes the default and records
    // the inertness measurement for its own bag; converging the two is issue
    // [#2099](https://github.com/go-to-k/cdkd/issues/2099).
    return redactSecretsForState(
      outputs,
      this.outputSecrets,
      this.outputsSourceUsable ? this.outputsTemplateSource : undefined,
      TEMPLATE_SOURCED_RULES
    );
  }

  /**
   * Redact resolved secret plaintext out of rollback-journal operations (GHSA
   * fix). Each op may carry resolved `properties` / `attemptedProperties` and a
   * `previousState` snapshot (whose `properties` / `attributes` /
   * `observedProperties` also hold resolved values). Each op is redacted with
   * the secrets recorded for ITS OWN resource (`perResourceSecrets`), so a
   * whole-secret value from one resource cannot rewrite another's literal.
   * Preserves ops that carry none of those fields, or whose resource recorded
   * no secret.
   *
   * The POSITION source matters MORE here than anywhere else (issue #1910).
   * This journal is not just persisted, it is REPLAYED to AWS by the rollback
   * executor's `resolveReplayProps`, so a leaf redacted onto a SIBLING's
   * expression — which is what the value-keyed map does when two expressions
   * resolve to one value — re-resolves at replay time to the wrong reference.
   * For two `:AWSCURRENT` / `:AWSPREVIOUS` stages of one secret that is the
   * wrong VERSION shipped to the live resource the moment the two diverge.
   *
   * The two SIDES take different sources, and conflating them would be a fresh
   * defect rather than a simplification: `properties` / `attemptedProperties`
   * are this deploy's DESIRED bags, produced by resolving the CURRENT template,
   * so the template bag positions them. `previousState` is a record read back
   * from STATE, whose leaves already hold expressions from whenever it was
   * written — the current template is not its source and may not even have the
   * same shape — so it is redacted against ITSELF via `scrubResourceRecord`,
   * the same #1900 fallback an UNCHANGED resource takes.
   */
  /**
   * Take a provider's `noEchoAttributes` declaration and turn it into REDACTION
   * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
   *
   * TWO registrations, and both are needed because `perResourceSecrets` is
   * keyed by LOGICAL ID:
   *
   * - the values go into the PRODUCER's own bag, which is what
   *   `scrubResourceRecord` redacts this record's `attributes` with;
   * - the logical id goes into {@link noEchoAttributeResources}, which every
   *   later resolution consults, so a DEPENDENT that resolves an `Fn::GetAtt`
   *   here records the same plaintext into ITS bag and its resolved
   *   `properties` are masked too. Without the second half the custom resource's
   *   record would be clean while the SSM parameter that consumed it still held
   *   the plaintext — a line that cannot be explained to someone who set
   *   `NoEcho` expecting "not in state".
   *
   * Called AFTER the provider returns and BEFORE the state record is built, so
   * the needles exist by the time anything is persisted. Nothing is masked in
   * memory: `stateResources[logicalId].attributes` keeps the REAL value, which
   * is what the resolver serves to dependents in this same run.
   *
   * `ownProperties` is the resource's OWN resolved template bag, and passing it
   * is what stops a handler from masking cdkd's inputs back at it (issue #2274
   * review). Its whole string leaves are EXCLUDED from the needles: a handler
   * echoing `event.ResourceProperties` into its `Data` — the shape the CDK
   * `Provider` samples encourage — makes `Data.X` equal the resource's own
   * `ServiceToken`, and registering that rewrites `properties.ServiceToken` to
   * `***` in the record `CustomResourceProvider.delete` reads it back from,
   * which can then no longer address the handler and skips the delete
   * (go-to-k/cdkd#3938).
   * A value already present in the template is not handler-GENERATED, so
   * excluding it gives up no secrecy — and where the template value IS a
   * resolved secret it already carries a real EXPRESSION needle, which
   * `recordMaskOnlyValue` would refuse to demote anyway.
   */
  private registerNoEchoAttributes(
    logicalId: string,
    result: {
      attributes?: Record<string, unknown>;
      noEchoAttributes?: boolean;
      noEchoAttributeNames?: readonly string[];
    },
    secrets: RecordedSecretValues,
    ownProperties?: Record<string, unknown>
  ): void {
    const attributes = result.attributes;
    if (attributes === undefined) return;
    const excluded = ownProperties === undefined ? undefined : wholeStringLeavesOf(ownProperties);
    if (result.noEchoAttributes === true) {
      this.noEchoAttributeResources.set(logicalId, true);
      recordMaskOnlyValuesIn(attributes, secrets, excluded);
      return;
    }
    // The PER-ATTRIBUTE arm. Filtered against the bag actually returned, so a
    // name the provider declared but did not deliver registers nothing — the
    // declaration is evidence about a VALUE, and with no value there is no
    // needle to record.
    const names = (result.noEchoAttributeNames ?? []).filter((name) => name in attributes);
    if (names.length === 0) return;
    this.noEchoAttributeResources.set(logicalId, new Set(names));
    for (const name of names) recordMaskOnlyValuesIn(attributes[name], secrets, excluded);
  }

  /**
   * The remedy clause of {@link refuseRedactedAttributeReads}'s import arm,
   * derived from the `reads` entries rather than described in prose.
   *
   * `ResolverContext.redactedAttributeReads` is HETEROGENEOUS, and the split
   * that matters is NOT which function pushed the entry — it is whether the
   * masked record lives in THIS stack's state, because only then can a
   * `--resource` re-import here reach it. FOUR populations reach the bag, and
   * each entry now says which it is IN ITS OWN FIELDS
   * ({@link RedactedAttributeRead}) rather than in a rendered string this
   * function re-parses:
   *
   *  - `kind: 'attribute'` with a `logicalId` — `noteAttributeSecrecy`, a
   *    resource in this stack. LOCAL.
   *  - `kind: 'attribute'` whose `logicalId` names an
   *    `AWS::CloudFormation::Stack` — ALSO `noteAttributeSecrecy`, and the
   *    reason `kind` alone cannot partition. A nested stack's output attribute
   *    reaches the cross-stack re-resolution arm only when it
   *    `carriesDynamicReference`, and a value that is already `SECRET_MASK`
   *    does NOT (that predicate tests for `{{resolve:`), so a masked child
   *    output falls through to `noteAttributeSecrecy` and is pushed as an
   *    ordinary local attribute read. Its record is the CHILD's
   *    `state.outputs`, from which the parent's attributes are rebuilt every
   *    deploy, so no `--resource` in THIS stack clears it:
   *    `NestedStackProvider` implements no `import()` at all, so the command
   *    would report `skipped-no-impl` and change nothing. FOREIGN, despite
   *    being local by kind.
   *  - `kind: 'cross-stack'` — `reresolveCrossStackValue`'s `Fn::ImportValue` /
   *    `Fn::GetStackOutput` / `nested stack <Child> Outputs.<Key>` forms. It
   *    carries NO `logicalId`, because there is no id in THIS stack to name.
   *    FOREIGN.
   *  - `kind: 'ref-state-key'` — `noteRefStateMask`, a resource in this stack
   *    whose CFn `Ref` value is recovered from a state key rather than from the
   *    physical id. LOCAL, and it earns a sentence of its own: the read is
   *    cdkd's, not the template's, so the `Fn::GetAtt` remedy "stop reading it"
   *    does not apply.
   *
   * Successive review rounds tried to express this as an instruction the reader
   * applies ("the name to the left of the dot"), and each phrasing was wrong
   * for a shape it had not considered — twice naming a REAL-but-wrong logical
   * id that the import typo guard ACCEPTS, so following it would
   * `--force`-overwrite an innocent row. Partitioning here makes each arm say
   * only what is true of its own shape, and makes a new shape a change to THIS
   * function rather than a silent widening of a sentence.
   *
   * **AND THE PARTITION READS FIELDS, NEVER A REGEX OVER `display`** (round-4
   * review). Two revisions parsed the rendering back into structure and each
   * shipped a defect: a hand-spelled pattern that a producer rename disarms,
   * then an `[A-Za-z0-9]+` id class that a HYPHENATED logical id falls out of —
   * and cdkd accepts one, because it validates no logical-id charset and never
   * hands the template to CloudFormation. Here falling out cost a re-import
   * command withheld; at `resolveOutputs`' guard the same miss cost the REFUSAL
   * itself. One rendering serving two consumers whose safe directions are
   * OPPOSITE is not a pattern to tune, so the structure moved into the data.
   *
   * The nested-stack case is excluded BY RESOURCE TYPE, not by an `Outputs.`
   * spelling. Keying on the segment over-reaches: a local
   * `AWS::ServiceCatalog::CloudFormationProvisionedProduct` documents
   * `Outputs.<Key>` as a real `Fn::GetAtt` attribute, so a masked one would be
   * misrouted to the foreign arm and the reachable remedy withheld. `resources`
   * is on the context already, so the type is available and exact.
   *
   * A LOCAL target whose type cannot be repaired by `cdkd import` at all gets
   * a THIRD arm since the issue #2847 round-2 review — a `Custom::*` /
   * `AWS::CloudFormation::CustomResource`, whose provider records no
   * attributes, so the import's same-physical-id carry-over restores the
   * masked bag and the refusal repeats forever. It is NOT simply excluded from
   * `isLocal`: that would route it to the FOREIGN arm, which asserts the record
   * lives in another stack, and for a custom resource in this very template
   * that is false. Its arm names the resource and withholds the command.
   *
   * An entry carrying NO `logicalId` is treated as foreign, which is both
   * correct (`cross-stack` is the only kind that omits it) and the safe
   * direction for a kind nobody has added yet: the foreign arm names no
   * command, so an unrecognised shape costs a vaguer message rather than a
   * destructive one.
   *
   * A logical id spelled `Ref Foo (state key X)`, or `My-Table`, or anything
   * else cdkd accepts, now routes on the FIELD and cannot be misread as another
   * row — the misparse the pre-round-4 regexes had to be anchored against.
   */
  /** @internal */
  static maskedRecordRemedyFor(
    reads: readonly RedactedAttributeRead[],
    resources: Record<string, { readonly resourceType?: string }>
  ): string {
    // Spelled locally rather than imported: the only exported copy lives in
    // `src/cli/commands/retire-cfn-stack.ts`, and a CLI -> deployment import
    // edge for one string literal is the wrong trade.
    // Several modules keep their own copy for that same reason; no count is
    // given, following `recreate-targets.ts`'s own note that an unfenced number
    // in a comment is one that goes stale. Theirs sit at module scope, this one
    // is function-local because this is its only reader.
    const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
    /**
     * Types whose `import()` can NEVER clear a mask, so advising a re-import
     * for them is a guaranteed no-op (issue #2847 round-2 review).
     *
     * TRACED, not assumed. `CustomResourceProvider.import` returns
     * `{ physicalId, attributes: {} }` unconditionally; `import.ts`'s
     * `reimportedAttributes` CARRIES FORWARD the prior record's attributes
     * for an empty bag whenever the physical id matches — which it does,
     * since the command is run with that very id. So the masked bag is copied
     * back verbatim (the import now warns that it was) and the refusal
     * repeats, forever.
     *
     * This is the NoEcho population — arm (1) of the refusal's own message —
     * which already has the right remedy there (force the custom resource to
     * update so its handler runs again). It gets its OWN arm rather than being
     * excluded from `isLocal`: excluding it would route the read to the FOREIGN
     * arm, which says the record lives in ANOTHER stack, and for a custom
     * resource sitting in this very template that is simply false. Narrower
     * than issue #2927, which is about a re-import whose `GetResource` merely
     * came back empty; here the provider cannot produce attributes at all.
     */
    const importCannotClearMask = (type: string | undefined): boolean =>
      type === 'AWS::CloudFormation::CustomResource' || (type?.startsWith('Custom::') ?? false);

    // THE ROUTING KEY IS THE FIELD, not a capture group. `resources` is read
    // with `Object.hasOwn` for the same reason `resolveRef` does (issue #2767):
    // `logicalId` is template-controlled, and a bare property read walks the
    // prototype chain, so an id of `constructor` answers with the `Object`
    // function rather than missing. It is HYGIENE here, not a fix — round-5
    // review measured that `resources['constructor']?.resourceType` is
    // `undefined` either way, so both spellings route the entry LOCAL and no
    // test can tell them apart. The guard is kept because the next field read
    // added here may not be so lucky.
    const typeOf = (read: RedactedAttributeRead): string | undefined =>
      read.logicalId !== undefined && Object.hasOwn(resources, read.logicalId)
        ? resources[read.logicalId]?.resourceType
        : undefined;
    const isLocal = (read: RedactedAttributeRead): boolean => {
      if (read.logicalId === undefined) return false;
      // A masked NESTED-STACK output is pushed as an ordinary attribute read
      // but its record is the child's; no `--resource` here reaches it.
      return typeOf(read) !== NESTED_STACK_RESOURCE_TYPE;
    };
    /** LOCAL, but no `cdkd import` can rewrite it — see above. */
    const isUnclearableLocal = (read: RedactedAttributeRead): boolean =>
      isLocal(read) && importCannotClearMask(typeOf(read));
    const targetOf = (read: RedactedAttributeRead): string | undefined => read.logicalId;

    const localTargets = [
      ...new Set(
        reads
          .filter((read) => isLocal(read) && !isUnclearableLocal(read))
          .map(targetOf)
          .filter((id): id is string => id !== undefined)
      ),
    ];
    const unclearableTargets = [
      ...new Set(
        reads
          .filter(isUnclearableLocal)
          .map(targetOf)
          .filter((id): id is string => id !== undefined)
      ),
    ];
    const foreignReads = reads.filter((read) => !isLocal(read));
    const hasRefStateRead = reads.some((read) => read.kind === 'ref-state-key' && isLocal(read));

    /**
     * A logical id rendered as a NAME rather than as a command argument
     * (go-to-k/cdkd#3435 security round).
     *
     * Every sentence below is joined into a `ProvisioningError` message that
     * `handleError` prints at DEFAULT verbosity, and neither `formatError` nor
     * the logger sanitizes `error.message` — they cover a `cause` and the extra
     * ARGS respectively. So a `Resources` KEY carrying `ESC[2K` + CR reached the
     * terminal raw, which is the same class this PR closed at 18 resolver
     * renders and missed one module out.
     */
    const shown = (id: string): string => displayIdent(id);

    /** CloudFormation's own logical-id length bound. */
    const CFN_LOGICAL_ID_MAX_LENGTH = 255;

    const parts: string[] = [];
    /** Pasteable commands, emitted LAST and one per line (go-to-k/cdkd#3436). */
    const commandLines: string[] = [];
    if (localTargets.length > 0) {
      // ONE COMMAND PER TARGET: naming several ids beside a single command
      // reads as though the one command covers them all.
      //
      // AND THE COMMAND IS WITHHELD FOR AN ID THAT IS NOT PASTEABLE
      // (go-to-k/cdkd#3435). Sanitizing the id in place is the WRONG remedy
      // here and was rejected for the reason this function's own header already
      // records about its round-4 regexes: a stripped id names a DIFFERENT,
      // possibly innocent row, and `cdkd import --force` accepts it. So the two
      // arms differ in kind — a pasteable id gets the runnable command, and
      // anything else gets its rendered NAME plus a sentence saying why the
      // command is not given. Same SPLIT `rollback-executor.ts` makes for
      // `cdkd rollback --orphan <id>`, through a stricter predicate — that
      // site takes CloudFormation's own `[A-Za-z0-9]` charset, and this one
      // must not, because cdkd validates no logical-id charset and a HYPHENATED
      // id is exactly the round-4 blocker this function's header records. A
      // `[A-Za-z0-9]` rule here was written first and MEASURED: it withheld the
      // command for `My-Table`, reddening four existing cases that pin the
      // hyphenated id reaching the LOCAL arm. `isPasteableIdent` is the rule
      // calibrated for cdkd's own id space (medial `~` / `_` / `.` / `-`
      // admitted, a LEADING one refused because that is where the option and
      // tilde-expansion shapes live).
      // The CAP is tightened at this call site (go-to-k/cdkd#3435 security
      // round 2). `isPasteableIdent` admits up to `STACK_REF_MAX_CODE_POINTS`,
      // which is right for its home population -- a cdkd state-record stack
      // name is minted recursively as `${parent}~${logicalId}` and is not
      // bounded by CloudFormation's 128. A LOGICAL ID has no such recursion, so
      // a thousand-character one is a payload on a default-verbosity line
      // rather than a legitimate value. No injection either way (the charset is
      // plain), so this is a bound, not a guard -- and it is applied HERE
      // rather than by loosening a shared security predicate's signature.
      const pasteableHere = (id: string): boolean =>
        isPasteableIdent(id) && id.length <= CFN_LOGICAL_ID_MAX_LENGTH;
      const pasteable = localTargets.filter(pasteableHere);
      const withheld = localTargets.filter((id) => !pasteableHere(id));
      if (pasteable.length > 0) {
        // The SENTENCE joins the prose; the commands go to `commandLines`, which
        // is emitted after every sentence (go-to-k/cdkd#3436). Pushing them here
        // put later prose on the same line as a command, which is the layout the
        // rule exists to prevent — and `parts` is space-joined, so a `\n` inside
        // one part does not make the command last.
        parts.push(`Re-import the record that HOLDS the mask (command(s) below).`);
        for (const id of pasteable) {
          // The old form wrapped the whole command in prose quotes AND left
          // `<stack>` / `<physicalId>` bare, which pasted as two redirections.
          // A LITERAL, not a gated value (go-to-k/cdkd#4205): the gate would
          // withhold `Tbl=<physicalId>` whole for the `<` and `>` of the hole
          // cdkd itself wrote into it (a mid-word `=` it admits), and the
          // command would no longer name the record. The only untrusted part is `id`, which `pasteableHere`
          // already held to `isPasteableIdent`, inert with no quotes at all.
          commandLines.push(
            `Re-import with: ${
              pasteableCommand('cdkd import', [
                { hole: 'stack' },
                { literal: `--resource ${shellQuote(`${id}=<physicalId>`)}` },
                { literal: '--force' },
              ]).command
            }`
          );
        }
      }
      if (withheld.length > 0) {
        parts.push(
          // NO backtick wrapper around the command. Pasted WITH its wrapper a
          // backtick span is command SUBSTITUTION -- a worse wrapper than
          // `'...'`, and one the source fence could not see until
          // go-to-k/cdkd#3613's M8 named it. Every placeholder here is a hole,
          // so nothing untrusted ran, but the shape is the one this class is
          // about and it should not be modelled in a message that exists to
          // explain the class. The command is DESCRIBED rather than offered,
          // because this arm's whole point is that it is withheld.
          `Re-import the record that HOLDS the mask for ${withheld.map(shown).join(', ')}, but ` +
            `the command is withheld: that is not a plain CloudFormation logical id, so a ` +
            `pasted cdkd import line could be reshaped by the shell or name a different ` +
            `resource. Read the id from 'cdkd state show' and quote it yourself, in ` +
            `cdkd import ${commandHole('stack')} --resource ` +
            `${commandHole('id')}=${commandHole('physicalId')} --force.`
        );
      }
    }
    if (unclearableTargets.length > 0) {
      // NAMES THE RESOURCE AND WITHHOLDS THE COMMAND. `CustomResourceProvider.import`
      // returns no attributes, and the import's same-physical-id carry-over
      // then restores the masked bag, so the re-import above would run cleanly
      // and change nothing.
      //
      // This arm names ids and NEVER pastes one, so it takes `shown`
      // unconditionally rather than the pasteable split above.
      parts.push(
        `Do NOT re-import ${unclearableTargets.map(shown).join(', ')}: a custom resource's ` +
          `import records no attributes, so the masked bag is carried forward unchanged and the ` +
          `refusal repeats. Cause (1) above is the one that applies to it.`
      );
    }
    if (foreignReads.length > 0) {
      // THREE arms, because two of them were each exact for one case and wrong
      // for another. The subject is the FOREIGN reads, so the number follows
      // their count (keying it to the local arm rendered "The read above
      // resolves" over two of them) — but "One of the reads" implies a set, so
      // it is wrong when the message listed exactly one read in total.
      const subject =
        reads.length === 1
          ? 'The read above resolves'
          : foreignReads.length === 1
            ? 'One of the reads above resolves'
            : 'Some of the reads above resolve';
      parts.push(
        `${subject} through ` +
          `ANOTHER stack (an Fn::ImportValue, an Fn::GetStackOutput, or a nested stack's ` +
          `Outputs), whose masked record lives in that stack's state — re-importing anything in ` +
          `this stack cannot clear it; act on the producer stack instead.`
      );
    }
    if (hasRefStateRead) {
      // The one arm that CORRECTS an instruction the refusal's own prose gives.
      // That prose ends its Cloud-Control arm with "stop reading it", which is
      // right for an `Fn::GetAtt` naming a non-attribute and wrong for a
      // `Ref`: CloudFormation defines these types' `Ref` as a state key rather
      // than the physical id, so cdkd issues the read on the template's behalf
      // and no template edit removes it.
      parts.push(
        `A 'Ref <LogicalId> (state key <Key>)' entry above is CDKD's own read, not one the ` +
          `template can stop making: CloudFormation defines that resource type's Ref value as ` +
          `that state key rather than the physical id, so the record must be repaired (re-import ` +
          `it, or let a deploy create or update the resource) — the "stop reading it" remedy does ` +
          `not apply to such an entry.`
      );
    }
    return [parts.join(' '), ...commandLines].join('\n');
  }

  /**
   * Refuse to provision a resource whose resolution served a REDACTED attribute
   * out of a previous deploy's state (issue #2274).
   *
   * The unavoidable cost of masking a `NoEcho` custom resource's `Data`: state
   * then holds `***`, and cdkd cannot get the value back without re-invoking
   * the handler, which is a SIDE-EFFECTING operation it must not perform just
   * to fill in a property. Since `ResourceState` carries no durable `NoEcho`
   * flag (issue #2449), there is not even a way to tell the user which
   * attribute it was without this record.
   *
   * REFUSING IS THE SAFE DIRECTION and the alternative is not "it works": the
   * literal `***` would be written to the live resource by any provider that
   * sends its desired bag wholesale (`PutParameter` and every
   * `Put*Configuration`), which is the issue #1498 / #1501 data-corruption
   * class. A loud failure naming the remedy is strictly better than a silent
   * wrong write.
   *
   * NARROW BY CONSTRUCTION. The bag is only non-empty when a resolution
   * actually served a masked value during THIS resource's resolution, so a
   * resource whose properties merely happen to contain the string `***` is
   * untouched — which is why the check is not "does `resolvedProps` hold the
   * mask". And the diff pass does not consult the bag at all, so an untouched
   * stack still reports NO_CHANGE and deploys.
   *
   * "A resolution", not "an `Fn::GetAtt`": the pushers are
   * `noteAttributeSecrecy`, `reresolveCrossStackValue` and — since the issue
   * #2847 review — `noteRefStateMask`, the `Ref` branch that reads a recovery
   * key out of the same persisted bags. {@link maskedRecordRemedyFor} is the
   * authority on the full shape list.
   *
   * This block sits DIRECTLY above its subject, and the previous revision's did
   * not: `maskedRecordRemedyFor` was inserted between the two, so JavaScript's
   * "only the LAST of two consecutive block comments attaches" rule (the same
   * one `cloud-control-provider.ts`'s `import()` doc warns about) silently
   * re-pointed 25 lines of doc at the wrong function and left this one with
   * none. Keep a new helper OUT of the gap.
   */
  private refuseRedactedAttributeReads(
    logicalId: string,
    resourceType: string,
    context: import('./intrinsic-function-resolver.js').ResolverContext
  ): void {
    const reads = context.redactedAttributeReads;
    if (reads === undefined || reads.length === 0) return;
    // TWO POPULATIONS REACH THIS REFUSAL, and naming only the first was a
    // measured defect (issue
    // [#2847](https://github.com/go-to-k/cdkd/issues/2847) review): since
    // `CloudControlProvider.import` masks the model keys it cannot certify as
    // attributes, a Cloud-Control-IMPORTED resource trips this too — and every
    // remedy below is custom-resource-only, so the user was handed three
    // instructions that cannot apply and none that can. The record carries no
    // durable marker saying WHICH population a mask came from (issue #2449 is
    // that gap), so the message names both rather than guessing.
    //
    // ARM (2) NAMES ONE ACTION AND DOES NOT ENUMERATE CAUSES, and that shape is
    // the point rather than brevity. Successive review rounds each rewrote this
    // arm as a cause list with a remedy per cause, and each list was wrong in a
    // NEW way — a remedy that could not apply, then a cause that cannot produce
    // this refusal, then a remedy necessary but not sufficient. Do not re-expand
    // it into a list: the causes are not enumerable from here —
    // `getTopLevelReadOnlyProperties` answers `undefined` for any failure at
    // all — so any list written here is a claim the code cannot support.
    //
    // THE TARGET IDS ARE COMPUTED, NOT DESCRIBED, and that is the fix for a
    // defect class rather than for one sentence. This method's `logicalId` is
    // the resource being PROVISIONED — the consumer that read the attribute —
    // while the masked record belongs to the READ's target. Successive rounds
    // tried to convey that in prose and each attempt was wrong for a `reads`
    // shape it had not considered: interpolating `logicalId` named the consumer
    // and told the user to `--force`-overwrite the wrong row; "the name to the
    // left of the dot" reads as `Outputs` for `nested stack Child Outputs.Foo`,
    // as `Cr.Endpoint` for a dotted attribute path like `Cr.Endpoint.Password`,
    // and has no referent at all for the `Fn::ImportValue` /
    // `Fn::GetStackOutput` forms. The population is heterogeneous, so no single
    // instruction describes it — `maskedRecordRemedyFor` PARTITIONS it instead,
    // and each arm says only what is true of its own shape. Adding a `reads`
    // shape means extending that helper, not this prose.
    //
    // THE COMMAND IS SELECTIVE AND CARRIES `--force`, and both halves were
    // traced through `cdkd import` rather than reasoned about. A BARE re-run is
    // actively destructive here: `CloudControlProvider.import` is
    // explicit-override-only, so with no `--resource` the resource resolves to
    // `skipped-not-found`, and auto mode rebuilds the resource map from
    // `{}` — the row is DROPPED from state and the next deploy tries to CREATE
    // a live resource. (Auto mode refuses without `--force` at all, so the user
    // would hit that wall first.) Selective mode merges onto the existing map,
    // and `--force` is required because the listed id already HAS a state entry
    // — the one holding the mask. `import.ts`'s own two refusals are the
    // authority for both clauses. A test pins this string per `reads` shape;
    // the rewrite history above is why it is pinned rather than trusted.
    //
    // ONE CASE THE COMMAND DOES NOT HEAL, narrow but real: if the re-import's
    // `GetResource` again yields no usable model, `import()` returns
    // `attributes: {}`, and `buildStackState`'s same-physical-id carry-over
    // keeps the PREVIOUS masked bag rather than replacing it — so the refusal
    // repeats. Deliberately: dropping the mask would make the read resolve to
    // the physical id instead. The import warns naming each kept key (issue
    // [#2927](https://github.com/go-to-k/cdkd/issues/2927)).
    throw new ProvisioningError(
      `Cannot resolve ${reads.map((read) => read.display).join(', ')} for ${logicalId}: cdkd's recorded state holds only the ` +
        `redaction mask there, and the value is not recoverable from state. There are two ways a ` +
        `record comes to hold the mask. (1) A custom resource handler declared its response ` +
        `NoEcho: true — the value is generated by the handler, so cdkd has nothing to re-derive ` +
        `it from and must not write the literal mask to AWS. Remedies: force that custom resource ` +
        `to update (change one of its properties, e.g. a nonce / version property) so its handler ` +
        `runs again and supplies the value in this same run; or stop setting NoEcho on that ` +
        `response. If the value comes from ANOTHER stack, the producer and this stack must deploy ` +
        `in ONE run (cdkd deploy --all) with the producer's custom resource actually running — ` +
        `re-deploying the producer by itself does not help, because it re-masks the value on the ` +
        `way into its own state. (2) The resource was adopted by 'cdkd import' through the Cloud ` +
        `Control fallback, which records only the attributes the type's CloudFormation schema ` +
        `declares read-only and masks the rest. Either the attribute named above is not one of ` +
        `them — CloudFormation would reject an Fn::GetAtt naming it too, so stop reading it — or ` +
        `cdkd could not read that schema and masked the whole model, which the import warned about ` +
        `when it happened. If that warning named a missing ` +
        `cloudformation:DescribeType permission, grant it first. ` +
        `See https://github.com/go-to-k/cdkd/issues/2449. ` +
        // LAST: the remedy ends in labelled command lines, and prose after them
        // lands on the final command's line (go-to-k/cdkd#3436).
        `${DeployEngine.maskedRecordRemedyFor(reads, context.resources)}`,
      resourceType,
      logicalId
    );
  }

  /**
   * Re-read a STALE record's attributes from AWS (issue
   * [#1852](https://github.com/go-to-k/cdkd/issues/1852)) — the resolver calls
   * this, through `ResolverContext.attributeHealer`, only when `Fn::GetAtt` is
   * about to take the physical-id fallback, or reaches one of the resolver's
   * heal-first arms (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627)).
   *
   * The read is the provider's `import()` with `knownPhysicalId` — the same
   * primitive `orphan-adoption.ts` verifies a record with. It is READ-ONLY by
   * contract ("verify the resource exists and fetch attributes, do NOT
   * search"), it returns the map `create()` records (so a healed record looks
   * like a fresh one), and it is routed by the record's own `resourceType` +
   * `provisionedBy`, so a Cloud-Control-routed record is read through Cloud
   * Control. `getAttribute()` was the alternative and is implemented by about
   * half the providers — neither of the two types this issue names.
   *
   * NEVER throws and never retries: every failure is an outcome the resolver
   * words its refusal from, and the memo makes one read per record per deploy
   * the ceiling.
   */
  private healStaleAttributes(
    logicalId: string,
    resource: ResourceState,
    stackName: string
  ): Promise<StaleAttributeHealOutcome> {
    // The eligibility gate runs on EVERY ask, ahead of the memo: the memo key
    // (logical id + physical id) survives an in-place UPDATE, so a read taken
    // by the diff pass would otherwise be served again AFTER this deploy
    // rewrote the record — a pre-update value handed out as the answer to a
    // miss that is now the provider's own.
    if (!this.isHealEligible(logicalId, resource)) {
      return Promise.resolve({ kind: 'not-attempted' });
    }
    // Encoded (go-to-k/cdkd#3496): a physical id is whatever AWS or the
    // template produced, and the record is an unchecked cast, so a separator
    // could let two records share one memo entry — one resource's read served
    // as another's heal. For string halves the old `<logicalId>\0<physicalId>`
    // key was already injective unless the logical id itself contains a NUL,
    // since the split point is then the FIRST NUL. cdkd validates no
    // logical-id charset, so a hand-written template or a hand-edited state
    // can carry one; encoding removes that precondition (and the
    // `[object Object]` conflation of non-string physical ids a template
    // literal had). Nothing else reads this key.
    const key = injectiveKey(logicalId, resource.physicalId);
    const inFlight = this.attributeHeals.get(key);
    if (inFlight) return inFlight;
    const heal = this.readStaleAttributes(logicalId, resource, stackName).catch(
      (error: unknown): StaleAttributeHealOutcome => ({ kind: 'failed', error })
    );
    this.attributeHeals.set(key, heal);
    return heal;
  }

  /**
   * Is `resource` still the record this deploy LOADED — same physical id, same
   * `attributes` object — and of a type whose attributes are an AWS read-back?
   * See {@link healBaseline}. Asked by the read AND by the persist merge: a
   * read taken before this deploy rewrote the record must reach neither a later
   * resolution nor the rewritten record.
   */
  private isHealEligible(logicalId: string, resource: ResourceState): boolean {
    const loaded = Object.hasOwn(this.healBaseline, logicalId)
      ? this.healBaseline[logicalId]
      : undefined;
    return (
      loaded !== undefined &&
      loaded.physicalId === resource.physicalId &&
      loaded.attributes === resource.attributes &&
      !isHealExcludedType(resource.resourceType)
    );
  }

  private async readStaleAttributes(
    logicalId: string,
    resource: ResourceState,
    stackName: string
  ): Promise<StaleAttributeHealOutcome> {
    // `getProviderFor` can throw for a type this build cannot route; the
    // caller's `.catch` turns that into `failed`, which is the honest outcome.
    const { provider } = this.providerRegistry.getProviderFor({
      resourceType: resource.resourceType,
      properties: resource.properties,
      provisionedBy: resource.provisionedBy,
      // The record is its own baseline (issue #3713): an unrecognized key it
      // carries is by definition unchanged, so the read stays on the layer
      // that wrote the record instead of moving to Cloud Control.
      previousProperties: resource.properties,
    });
    // The read's logic is shared with `cdkd diff`'s read-only healer, so a
    // guard or masking rule cannot land in only one of them (go-to-k/cdkd#4196).
    const outcome = await readRecordAttributes({
      provider,
      logicalId,
      resource,
      stackName,
      region: this.stackRegion,
    });
    if (outcome.kind !== 'read') return outcome;
    const { attributes } = outcome;
    if (Object.keys(attributes).length > 0) {
      this.healedAttributes.set(logicalId, {
        physicalId: resource.physicalId,
        resourceType: resource.resourceType,
        attributes,
      });
    }
    this.logger.debug(
      `Re-read the attributes of ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)}) from AWS — its state record lacked one a Fn::GetAtt asked for (#1852): ${Object.keys(attributes).length} attribute(s) read`
    );
    return outcome;
  }

  /**
   * The record to persist for `logicalId`: `record` itself, or a copy whose
   * `attributes` gained what this deploy's heal read. MERGED, never replaced —
   * only `attributes` is touched, and within it only keys the record does not
   * hold (or holds as a pre-#1681 placeholder ARN). Skipped when the record no
   * longer describes the resource that was read: a replacement or a Type change
   * this deploy made.
   */
  private withHealedAttributes(logicalId: string, record: ResourceState): ResourceState {
    const healed = this.healedAttributes.get(logicalId);
    if (
      healed === undefined ||
      healed.physicalId !== record.physicalId ||
      healed.resourceType !== record.resourceType ||
      // Rewritten by a provider THIS deploy (in place, so the ids still match):
      // its new attribute map is the provider's answer, and a read taken before
      // the update must not be merged under it.
      !this.isHealEligible(logicalId, record)
    ) {
      return record;
    }
    const merged = mergeHealedAttributes(record.attributes, healed.attributes, (key, value) =>
      isStalePlaceholderArnAttribute(record.resourceType, key, value)
    );
    return merged === record.attributes || merged === undefined
      ? record
      : { ...record, attributes: merged };
  }

  /** Would a save of `resources` persist something a heal read? The no-change path's trigger. */
  private hasUnpersistedHeals(resources: Readonly<Record<string, ResourceState>>): boolean {
    for (const logicalId of this.healedAttributes.keys()) {
      const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
      if (record !== undefined && this.withHealedAttributes(logicalId, record) !== record) {
        return true;
      }
    }
    return false;
  }

  private redactStateForPersist(state: StackState): StackState {
    const resources: Record<string, ResourceState> = {};
    for (const [logicalId, record] of Object.entries(state.resources)) {
      // Redact each record ONLY with the secrets substituted during that
      // resource's own resolution — see the `perResourceSecrets` field doc.
      const secrets = this.perResourceSecrets.get(logicalId);
      // The template bag is the POSITION source (#1904); when this resource was
      // not resolved this deploy there is none, and `scrubResourceRecord` falls
      // back to the record's own `properties` for the observed bag (#1900).
      const templateProps = this.perResourceTemplateProps.get(logicalId);
      resources[logicalId] = scrubResourceRecord(
        // Issue #1852: merged BEFORE the scrub, so a healed value enters the
        // same pass a provider-recorded attribute does. That pass has no needles
        // for an UNCHANGED record (nothing resolved for it this deploy), so what
        // keeps a sensitive value out is the read itself: masked keys are
        // dropped in `readRecordAttributes`, and custom resources / nested stacks
        // are never read.
        this.withHealedAttributes(logicalId, record),
        secrets ?? new Map<string, string>(),
        // No template bag means this resource was not resolved this deploy (an
        // UNCHANGED one). `scrubResourceRecord` then falls back to the record's
        // own already-redacted properties as the observed bag's source, which is
        // the #1900 path — so do NOT "simplify" this to `templateProps!`.
        templateProps
      );
    }
    // `outputs` is also secret-bearing: a `CfnOutput` whose Value resolves a
    // SECRET dynamic reference (`{{resolve:secretsmanager:...}}`, or a
    // `{{resolve:ssm:...}}` pointing at a `SecureString` parameter — issue
    // #1901 — including an Fn::Sub/Join embedding one) stores the resolved
    // plaintext, which would otherwise reach
    // state.json / the exports index / the deploy summary. Redact it with the
    // OUTPUTS' own secrets map (a literal output equal to a secret is not
    // recorded there, so it is not touched).
    // `orphans` carries a whole `ResourceState` each (issue #2934), so it is
    // secret-bearing in exactly the way `resources` is — and it is a TOP-LEVEL
    // field, which means the `...state` spread below would otherwise carry it
    // through this choke point UNTOUCHED. That matters most on the path that
    // creates the records: the automatic rollback captures from the in-memory
    // map, which holds REAL resolved values by design (see the create site's
    // "The REAL attribute values, deliberately" note), so an unscrubbed entry
    // writes secret plaintext into state.json — the GHSA-p5qg-v9gv-hc7w class.
    //
    // Keyed by the record's own logical id AND its resource TYPE. The id alone
    // is not enough: a CDK refactor can reuse a logical id for an unrelated
    // resource, and then this deploy's maps hold the NEW resource's needles and
    // template bag. Scrubbing the old record with those splices a new secret's
    // plaintext into the old record's literals wherever it coincides as a
    // substring — the over-redaction / coinciding-literal class — and picks a
    // position source that describes a different resource entirely.
    //
    // When the type matches, the maps describe the same resource and their
    // needles are the right ones. When it does not (and in the ordinary case,
    // where the orphan is not in this deploy's template at all), both miss and
    // `scrubResourceRecord` takes the #1900 fall-back, treating the record's own
    // already-redacted properties as the observed bag's source. That is correct
    // rather than merely tolerable: a record minted by an earlier rollback was
    // already scrubbed when it was written, so the identity return preserves it.
    const orphans = state.orphans?.map((entry) => {
      // Did THIS deploy resolve that logical id, as that same TYPE? Only then
      // do the needles describe this record.
      //
      // Keyed on what the deploy RESOLVED, not on `state.resources`: an orphan
      // is by definition absent from `resources`, so that spelling read false
      // for the record being MINTED — the needles went empty and the plaintext
      // survived. Measured by `tests/integration/retain-orphan-secret`.
      const sameResource =
        this.perResourceResolvedType.get(entry.logicalId) === entry.state.resourceType;
      return {
        ...entry,
        state: scrubResourceRecord(
          entry.state,
          (sameResource ? this.perResourceSecrets.get(entry.logicalId) : undefined) ??
            new Map<string, string>(),
          sameResource ? this.perResourceTemplateProps.get(entry.logicalId) : undefined
        ),
      };
    });
    // ORDER IS LOAD-BEARING, and it is the opposite of how this read when the
    // cross-stack redaction was added (issue
    // [#3289](https://github.com/go-to-k/cdkd/issues/3289), security review).
    // `absorbOutputsPassSecrets` is the only writer of `outputSecrets`, and on
    // THIS path `redactOutputs` is what calls it — so a cross-stack redaction
    // evaluated first reads that bag EMPTY. (`crossStackReadKeyNormalizer`
    // calls the absorb itself, for the same reason one level earlier.) The success path hides it (the
    // outputs pass drains earlier there), but `persistStateAfterOutputFailure`
    // reaches here from the `catch` with nothing absorbed, and that is exactly
    // the shape this redaction exists for: an `Fn::GetStackOutput` whose
    // StackName an `Fn::Sub` built from a secret, in a deploy whose outputs
    // pass then threw. Redact the outputs FIRST so the bag is filled.
    const outputs = this.redactOutputs(state.outputs);
    const crossStackReads = this.redactCrossStackReads(state);
    return {
      ...state,
      resources,
      outputs,
      ...(orphans === undefined ? {} : { orphans }),
      ...crossStackReads,
    };
  }

  /**
   * Redact the TEMPLATE-DERIVED names in `state.imports` / `state.outputReads`
   * (issue [#3289](https://github.com/go-to-k/cdkd/issues/3289)).
   *
   * Both lists rode the `...state` spread unredacted, so a reference whose name
   * an `Fn::Sub` assembled around a resolved secret persisted that secret in
   * plaintext, durably. The fields are NOT symmetric and the issue as filed
   * named the wrong ones, so the provenance of each is stated here rather than
   * left to be re-derived:
   *
   * - `imports[].exportName` IS template-derived (`resolveValue` on the
   *   `Fn::ImportValue` argument), so it leaks. Its `sourceStack` /
   *   `sourceRegion` are NOT: `recordImport` takes them from the exports index
   *   entry or the state scan, i.e. from the producer's own record.
   * - `outputReads[]` has TWO leaking fields: `outputName` AND `sourceStack`,
   *   both `resolveValue` on `Fn::GetStackOutput` arguments. `sourceRegion` is
   *   template-derived too but passes `isClientSafeRegion` before it can be
   *   recorded, and it is read STRUCTURALLY (`producerRegionsFromState` keys a
   *   secret-region decision on it), so it is deliberately left alone.
   *
   * REDACTION HAPPENS HERE, at the persist choke point, and must not move to
   * record time: `crossStackReadsForPartialSave` / `unionCrossStackReads` dedup
   * on the (source stack, region, name) triple, so changing a value mid-run makes
   * the union write BOTH spellings, and its first-seen-wins merge would keep
   * whichever arrived first.
   *
   * `outputReads[].sourceStack` is both a leak and the literal match key
   * `findDownstreamConsumers` compares against, so redacting it necessarily
   * stops that match. That reader reports rather than drops — see
   * `recreate-downstream-consumers.ts`; a consumer vanishing from a DATA-LOSS
   * prompt is a worse failure than one it cannot name precisely.
   *
   * The union bag is every secret THIS deploy resolved, because a
   * cross-stack reference can sit in a resource property (recorded per logical
   * id) or in an Output (recorded in the outputs pass), and the entry carries
   * no logical id to narrow it by.
   */
  private redactCrossStackReads(state: StackState): Pick<StackState, 'imports' | 'outputReads'> {
    if (state.imports === undefined && state.outputReads === undefined) return {};
    const secrets = this.allRecordedSecrets();
    // No early return for an EMPTY bag. There was one, returning the lists
    // verbatim, and it was behaviourally DEAD: the caller spreads `...state`
    // first, so an absent key here leaves the original in place either way.
    // A branch no probe can red is worse than no branch -- a test naming it
    // passes through the spread instead and reads as coverage (measured in
    // review: inserting `return {}` there left the whole suite green).
    // The map below is identity work on an empty bag.
    // Field-by-field rather than handing the whole entry to
    // `redactSecretsForState`: the walk would also rewrite `sourceRegion` and
    // `imports[].sourceStack`, which are not template-derived and are read as
    // match keys. Each field is a bare string, so the value scan is the only
    // arm that can apply and a source bag would buy nothing.
    const redact = (value: string): string => redactSecretsForState(value, secrets);
    return {
      ...(state.imports === undefined
        ? {}
        : {
            imports: state.imports.map((entry) => ({
              ...entry,
              exportName: redact(entry.exportName),
            })),
          }),
      ...(state.outputReads === undefined
        ? {}
        : {
            outputReads: state.outputReads.map((entry) => ({
              ...entry,
              sourceStack: redact(entry.sourceStack),
              outputName: redact(entry.outputName),
            })),
          }),
    };
  }

  /**
   * The name normalizer `crossStackReadsForPartialSave` keys its union on
   * (issue [#3289](https://github.com/go-to-k/cdkd/issues/3289)).
   *
   * It applies the SAME redaction the persist path applies, so a name this run
   * holds in plaintext and the name the previous record holds redacted produce
   * ONE key. Without it the union keeps both and the persist redaction makes
   * them identical duplicates. The parameter's own doc carries the measurement.
   *
   * Returns identity when this deploy resolved no secret, which keeps the key
   * byte-identical to the pre-#3289 one for every stack that has none.
   */
  /** @internal */
  crossStackReadKeyNormalizer(): (name: string) => string {
    // ABSORB FIRST, the same reason `redactOutputs` does and the same reason
    // the persist order was corrected: `outputSecrets` is written only by
    // `absorbOutputsPassSecrets`, and every caller of THIS method evaluates it
    // inside a state literal -- i.e. BEFORE `withParentInfo` reaches
    // `redactStateForPersist`. Without the drain the bag is empty here, the
    // identity arm below is taken, and the duplicate this normalizer exists to
    // stop survives on exactly the path the round-1 blocker was on: a
    // `Fn::GetStackOutput` in a `CfnOutput.Value` (so the needle is in the
    // outputs pass only) on a deploy whose outputs pass then threw.
    //
    // Fixing the persist order and leaving this one is how the same defect
    // shipped twice in one PR. Calling the absorb from both places is safe:
    // measured, a second call re-sets equal entries and `recordResolvedPair`
    // leaves an unchanged pair alone, so it invents no CONFLICTING marker.
    this.absorbOutputsPassSecrets();
    const secrets = this.allRecordedSecrets();
    if (secrets.size === 0) return (name) => name;
    return (name) => redactSecretsForState(name, secrets);
  }

  /**
   * Every secret this deploy resolved, in one bag.
   *
   * `perResourceSecrets` is keyed by logical id and `outputSecrets` holds the
   * outputs pass, which is the right scoping for a RECORD (a resource's own
   * secrets redact that resource). A cross-stack read entry carries no logical
   * id, so it has nothing to be scoped BY — the reference may have sat in any
   * resource's property or in an Output.
   *
   * Over-redaction here is the safe direction and is bounded the same way the
   * value scan always is: `MIN_NEEDLE_LENGTH` keeps a short plaintext from
   * matching a substring, and an export name that genuinely equals another
   * resource's secret is a name that should not be persisted either.
   */
  private allRecordedSecrets(): RecordedSecretValues {
    const all: RecordedSecretValues = new Map();
    for (const bag of this.perResourceSecrets.values()) {
      for (const [plaintext, expression] of bag) all.set(plaintext, expression);
    }
    for (const [plaintext, expression] of this.outputSecrets) all.set(plaintext, expression);
    return all;
  }

  /**
   * Stamp `parentStack` / `parentLogicalId` / `parentRegion` (schema v6+)
   * onto a state object that's about to be saved, when this engine was
   * constructed with `options.parentStackInfo` (= it's deploying a
   * nested-stack child). Returns the state unchanged for top-level
   * deploys so the three v6 fields stay absent from non-child state files.
   *
   * ALSO the single choke point where resolved SECRET plaintext is redacted out
   * of the persisted state (GHSA fix): every `stateBackend.saveState` call in
   * this engine wraps its state through here, so redacting `resources` once here
   * covers `properties` / `attributes` / `observedProperties` across every
   * create / update / replacement / rollback / observed-capture path uniformly —
   * including the async observed-capture drain that runs after the resolver
   * context is gone (which is why the secret map is session-wide).
   */
  private withParentInfo(state: StackState): StackState {
    const redacted = this.redactStateForPersist(state);
    if (!this.options.parentStackInfo) return redacted;
    const { parentStack, parentLogicalId, parentRegion } = this.options.parentStackInfo;
    return {
      ...redacted,
      parentStack,
      parentLogicalId,
      parentRegion,
    };
  }

  /**
   * Read a reader back from AWS to decide the replacement ceiling of a
   * create-only property that carries a `NoEcho` value supplied in THIS deploy
   * (go-to-k/cdkd#3729). The record holds only `***` there, so it cannot say
   * whether the value moved; AWS can.
   *
   * What makes it safe:
   *  - It hands the provider the RECORD's `properties`, where the value is
   *    `***`, never the resolved bag. A provider that echoes its `properties`
   *    argument for a field AWS does not return therefore reports `***`, which
   *    never equals the value. The deploy-time observed capture passes the
   *    resolved bag; this read must not take that call shape.
   *  - The provider is routed by the RECORD (its type and `provisionedBy`), as
   *    the deploy-start refresh does: the question is what the EXISTING
   *    resource holds. A `cc-api` record reads through Cloud Control.
   *  - The readback stays in this call. It is never installed as
   *    `observedProperties`, never joins `observedCaptureTasks`, and is dropped
   *    once compared. It is not gated on `--no-capture-observed-state`, which
   *    is about the persisted drift baseline, and this read persists nothing.
   *  - A throw of any kind, or a read outliving its cap, is `read-failed`. The
   *    error is masked with the resource's bag, and only its `name` is logged,
   *    never its message, which could echo the value.
   */
  private async readReaderForFreshNoEchoCeiling(
    logicalId: string,
    currentResource: ResourceState,
    secrets: RecordedSecretValues
  ): Promise<FreshNoEchoReadback> {
    let provider: ResourceProvider;
    try {
      provider = this.providerRegistry.getProviderFor({
        resourceType: currentResource.resourceType,
        provisionedBy: currentResource.provisionedBy,
      }).provider;
    } catch {
      return { failure: 'not-readable' };
    }
    const readCurrentState = provider.readCurrentState?.bind(provider);
    if (readCurrentState === undefined) return { failure: 'not-readable' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const live = await Promise.race([
        Promise.resolve().then(() =>
          readCurrentState(
            currentResource.physicalId,
            logicalId,
            currentResource.resourceType,
            currentResource.properties
          )
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('readback timed out')),
            this.noEchoCeilingReadbackTimeoutMs
          );
        }),
      ]);
      if (live === undefined || live === null || typeof live !== 'object') {
        return { failure: 'not-readable' };
      }
      return { live };
    } catch (error: unknown) {
      // `maskSecretsInError` masks `message` / `stack` / `cause`, not `name`:
      // only an identifier-shaped name is printed. Guarded, so an error whose
      // getters throw still reads as `read-failed` rather than escaping.
      let errorClass = 'Error';
      try {
        const masked = maskSecretsInError(error, secrets);
        const name = masked instanceof Error ? masked.name : typeof masked;
        if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)) errorClass = name;
      } catch {
        // keep 'Error'
      }
      this.logger.debug(
        safeMsg`Readback of ${logicalId} for a NoEcho value's replacement check failed (${errorClass}).`
      );
      return { failure: 'read-failed' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * go-to-k/cdkd#4156: the live predicate handed to an `AWS::IAM::Policy`
   * update or delete, so it does not remove a name another resource of this
   * deploy has ALREADY written onto a principal
   * (`src/deployment/inline-policy-claims.ts`). It reads the writers' records
   * at call time. `undefined` for every other type.
   */
  private inlinePolicyClaimedFor(
    resourceType: string,
    logicalId: string,
    stateResources: Record<string, ResourceState>
  ): InlinePolicyClaimed | undefined {
    if (resourceType !== 'AWS::IAM::Policy') return undefined;
    const args = {
      selfLogicalId: logicalId,
      writers: this.inlinePolicyWriters,
      changes: this.deployChanges,
      stateResources,
    };
    return (kind, principal, policyName) =>
      isInlinePolicyClaimedByCompletedWriter(args, kind, principal, policyName);
  }

  /**
   * go-to-k/cdkd#4156: record a resource's completed provider write. Every
   * type is recorded; the predicate reads only the IAM types' records.
   */
  private recordInlinePolicyWrite(logicalId: string, write: InlinePolicyWrite): void {
    this.inlinePolicyWriters.set(logicalId, write);
  }

  private async doDeploy(
    stackName: string,
    template: CloudFormationTemplate
  ): Promise<DeployResult> {
    // Warm the create-only DescribeType cache in parallel with the lock + state
    // read below. calculateDiff (further down) resolves each UPDATE resource's
    // create-only property paths via cloudformation:DescribeType (~0.8s cold per
    // type, cached per-type for the deploy lifetime). Kicking those lookups off
    // here for the template's distinct resource types — fire-and-forget — lets
    // the diff's awaits hit a warm cache instead of paying the round-trip inline
    // on the critical path. prefetchCreateOnlyPropertyPaths is idempotent
    // (per-type module cache) and never throws, and the diff awaits the same
    // per-type lookups, so this is pure latency-hiding with no correctness
    // impact. Custom types short-
    // circuit without an API call; on a pure-CREATE (first) deploy the diff makes
    // no create-only lookups at all, so the prefetched entries simply go unused
    // that run — bounded, deduped, non-blocking waste, never a correctness issue.
    // Part of #1180.
    //
    // Schema-less types are filtered out: `AWS::CDK::Metadata` (the CDK
    // construct-tree sentinel every synthesized template carries) and custom
    // resources have no CloudFormation registry entry, so DescribeType can
    // only fail for them. Before the filter, every single deploy burned one
    // guaranteed-to-fail API call on the metadata sentinel AND printed a
    // "Grant cloudformation:DescribeType ..." warning naming a pseudo-resource
    // the user cannot act on. The diff / type-validation / property-validation
    // passes below already exclude `AWS::CDK::Metadata`; this makes the
    // prefetch consistent with them. `hasNoRegistrySchema` short-circuits
    // inside the resolver too, so this filter is the cheap outer guard.
    //
    // The prefetch runs as BACKGROUND DescribeType calls under the shared
    // concurrency cap (issue #3718): an unbounded 134-type burst throttled
    // almost half its calls, and a lookup whose retries ran out lost the
    // live schema. The diff's own awaited lookups queue ahead of it.
    //
    // Cancelled when the deploy finishes, on every path (issue #3718): the
    // prefetch is opportunistic, and an unfinished background lookup must not
    // keep a finished deploy's process alive. The handle is this engine's own,
    // so a nested child engine finishing cannot withdraw its parent's calls.
    const createOnlyPrefetch = prefetchCreateOnlyPropertyPaths(
      templateResourceTypes(template.Resources).filter((type) => !hasNoRegistrySchema(type))
    );
    try {
      return await this.doDeployWithPrefetch(stackName, template, createOnlyPrefetch);
    } finally {
      createOnlyPrefetch.cancel();
    }
  }

  private async doDeployWithPrefetch(
    stackName: string,
    template: CloudFormationTemplate,
    createOnlyPrefetch: CreateOnlyPrefetch
  ): Promise<DeployResult> {
    const startTime = Date.now();
    this.logger.debug(`Starting deployment for stack: ${stackName}`);

    // Live progress renderer: shows in-flight resources as a multi-line area
    // at the bottom of the terminal. Self-disables on non-TTY and when
    // `CDKD_NO_LIVE=1` is set (the CLI sets this in verbose mode so debug
    // logs do not interleave with the live area). Created (not started)
    // before the lock acquisition below because the SIGINT handler routes
    // its notice through it; `printAbove` falls through to a direct write
    // while the renderer is not yet started.
    const renderer = getLiveRenderer();

    // Register SIGINT handler to save partial state on Ctrl+C. Registered
    // BEFORE `acquireLockWithRetry` (issue #1348) so a signal landing during
    // the acquisition's S3 round-trip flips the interrupt flag instead of
    // hitting the unhandled default (or the #1342 forwarder's exit-143
    // fallback) and stranding the just-written lock: with the flag set, the
    // DAG executor dispatches no work and the `finally` below releases the
    // lock through the normal path.
    this.interrupted = false;
    this.interruptCause = null;
    const sigintHandler = () => {
      // Route the interrupt notice through the live renderer so it does not
      // collide with the in-flight task display.
      renderer.printAbove(() => {
        process.stderr.write(
          '\nInterrupted — saving partial state after current operations complete...\n'
        );
      });
      this.interrupted = true;
      this.interruptCause ??= 'user';
    };
    process.on('SIGINT', sigintHandler);

    // Acquire lock with retry (retries up to 3 times with 2s delay for transient lock conflicts)
    try {
      await this.lockManager.acquireLockWithRetry(stackName, this.stackRegion, undefined, 'deploy');
    } catch (error) {
      // The try/finally that owns the listener removal starts below — clean
      // up here so an acquire failure does not leak the handler.
      process.removeListener('SIGINT', sigintHandler);
      throw error;
    }

    try {
      // Started INSIDE this `try` (issue #2171): `start()` writes to stdout and
      // can throw (EPIPE on `cdkd deploy | head`), and it sits AFTER the lock
      // acquisition, so a throw outside would strand the lock for its full TTL.
      // This is the same move issue #2161 made in `destroy-runner.ts`; the two
      // commands had the identical shape and only one of them was fixed.
      renderer.start();

      // 1. Load current state
      const currentStateData = await this.stateBackend.getState(stackName, this.stackRegion);
      const currentState: StackState = currentStateData?.state ?? {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName,
        resources: {},
        outputs: {},
        // A record that does not exist yet exports nothing, and that is KNOWN
        // (issue #2193): a first deploy that fails before its outputs resolve
        // carries this bag forward, and must not persist it as "not known".
        exportNames: [],
        lastModified: Date.now(),
      };
      const currentEtag = currentStateData?.etag;
      this.healBaseline = currentState.resources ?? {};
      // AT THE LOAD, and REFUSE rather than repair (issue #3207). `deploy` is
      // the most write-capable consumer of this bag there is: the no-change
      // merge path below carries `currentState.outputs ?? {}` into
      // `persistedOutputs` and SAVES it, five failure-path saves write
      // `outputs: currentState.outputs` verbatim, and the next success
      // republishes the result into `cdkd/_index/<region>/exports.json` — the
      // namespace every other stack's `Fn::ImportValue` binds against. So a
      // string bag is rebuilt into a well-formed map of one fabricated export
      // per CHARACTER and the only signal the record was damaged is gone
      // permanently: the laundering go-to-k/cdkd#3192 exists to stop.
      //
      // Here rather than at the twelve later reads because every one of them is
      // dominated by this point, which is the placement rule
      // `repairMalformedResourcesForReadOnly`'s own note records: a per-walk
      // `?? {}` is inert for this class, since each flow dereferences the
      // container a line earlier.
      refuseMalformedOutputs(currentState, stackName, this.stackRegion);
      // And the `resources` bag, a SEPARATE container with a separate absence
      // rule, refused separately so the message names the one that is broken
      // (issue go-to-k/cdkd#3161).
      //
      // The gap go-to-k/cdkd#3317 measured and left: it closed the per-ENTRY
      // `properties` map at `DiffCalculator.calculateDiff`, and that
      // predicate returns `[]` for a record whose ROOT bag is itself
      // unreadable — so `"resources": "abcdef"` still reached the diff and
      // enumerated two fabricated logical ids, while a `[]` or a `5`
      // enumerated none and planned every template resource as a CREATE,
      // re-provisioning a stack that already exists.
      //
      // HERE rather than at `calculateDiff`, although that is the chokepoint
      // both diff callers share: this load DOMINATES the call and the reads
      // between them, the first of which is the `Object.keys(...)` debug line
      // immediately below — where a `null` bag raised the bare `TypeError`
      // go-to-k/cdkd#3018 exists to remove. `cdkd diff` keeps its repair-and-warn
      // half at its own load, so the preview this refusal points at still works.
      refuseMalformedResourcesForDeploy(currentState, stackName, this.stackRegion);
      // And each ROW of that bag (go-to-k/cdkd#3314). A `null` or typeless row
      // reads as absent in the diff and is planned as a CREATE of a resource
      // this stack already manages. `calculateDiff` refuses it too, but two
      // walks run before the diff and each died on the row first, with a bare
      // `TypeError`: the CLI's prefix-migration gate (`onCurrentStateLoaded`
      // below) and the observed-state auto-refresh. The load dominates both.
      // It does not dominate the CLI's PRE-lock `--recreate-via-*` check, which
      // reads the named rows itself (go-to-k/cdkd#3202 owns that site).
      refuseMalformedResourceEntriesForDeploy(currentState, stackName, this.stackRegion);
      // The `orphans` CONTAINER, beside it and for the same placement reason
      // (go-to-k/cdkd#3379): the adoption pass below reads it on a bare `?? []`
      // and ASSIGNS `currentState.orphans` from what it read, so an unreadable
      // container is rewritten by a writer. AFTER the lock, so the guarantee is
      // "before any resource operation" rather than "before any lock".
      refuseMalformedOrphans(currentState, stackName, this.stackRegion);
      // The ROWS of a readable list (go-to-k/cdkd#3500). Its own call because
      // the questions are independent: the adoption pass below dereferences
      // each row's `state`, and `orphansAfterRollback` keys its merge map on
      // each row's `logicalId`, so a list that IS a list can still abort the
      // run, or collapse the rows MISSING a `logicalId` into one saved survivor.
      refuseMalformedOrphanRecords(currentState, stackName, this.stackRegion);
      // Set when we loaded a `version: 1` legacy record. The next save
      // migrates it to the new key.
      const migrationPending = currentStateData?.migrationPending ?? false;

      this.logger.debug(
        `Loaded current state: ${Object.keys(currentState.resources).length} resources`
      );

      // 1a-pre. Pre-provisioning gate. Runs before the journal note, the
      // observed-properties refresh, parsing, the diff and every provider
      // call — so a caller that declines here has changed nothing. Reuses
      // the state read just performed instead of making the CLI issue its
      // own pre-lock GET of the same object.
      if (this.options.onCurrentStateLoaded) {
        await this.options.onCurrentStateLoaded(stackName, currentStateData?.state);
      }

      // 1b. If a rollback journal exists, a previous deploy failed / was
      // interrupted and has not yet been reverted (issue #1183). Note that
      // `cdkd rollback` can revert it; the deploy proceeds (fix-forward is
      // still supported). Best-effort — a journal read failure must not
      // block the deploy.
      try {
        const loaded = await this.stateBackend.loadRollbackJournal(stackName, this.stackRegion);
        // A nested child's `nested-pending-parent` segments record a deploy
        // that SUCCEEDED while its parent's was still running (issue #3754);
        // they are its parent's to replay, not a failure to report here.
        const journal = loaded && {
          ...loaded,
          segments: loaded.segments.filter((s) => s.reason !== NESTED_PENDING_PARENT_REASON),
        };
        if (journal && journal.segments.length > 0) {
          // A journal whose every segment carries no completed ops is the
          // failed-only shape kept after a CLEAN automatic rollback (issue
          // #1208) — the stack is already back at its pre-deploy baseline,
          // so the generic "run cdkd rollback to revert" advice would be
          // misleading (a plain rollback is a no-op replay there). Detected
          // structurally, not by reason, so mixed journals keep the generic
          // note.
          const failedOnly =
            journal.segments.every((s) => s.operations.length === 0) &&
            journal.segments.some((s) => (s.failedOperations?.length ?? 0) > 0);
          this.logger.info(
            failedOnly
              ? `A previous deploy of ${displayStackName(stackName)} failed and was automatically rolled back. ` +
                  `The failed resource may be partially applied — revert it, or continue ` +
                  `deploying to fix forward (${
                    // Issue #3754: a nested child's journal is cleared by its
                    // TOP-LEVEL stack's success, not by its own.
                    this.options.parentStackInfo
                      ? 'a successful deploy of the top-level stack clears this note'
                      : 'a successful deploy clears this note'
                  }).` +
                  `\nRevert it with: ${
                    pasteableCommand('cdkd rollback', [
                      { value: stackName, hole: 'stack' },
                      { literal: '--revert-failed' },
                    ]).command
                  }`
              : `A previous deploy of ${displayStackName(stackName)} failed or was interrupted. Revert it, ` +
                  `or continue deploying to fix forward.` +
                  `\nRevert it with: ${
                    pasteableCommand('cdkd rollback', [{ value: stackName, hole: 'stack' }]).command
                  }`
          );
        }
      } catch {
        // ignore — journal is advisory here
      }

      // 1-pre. Issue #3468: read every REASON-LESS baseline refusal before
      // anything in this deploy can take a readback. See the method's doc.
      this.stampReasonlessParameterRefusals(currentState.resources, template);

      // 1a. Auto-refresh observedProperties for any state entry that lacks it
      // (state written by an older binary / direct edit). Fires
      // `provider.readCurrentState` fire-and-forget through the same
      // `kickOffObservedCapture` pipeline that successful CREATE / UPDATE
      // uses, so the in-flight set is drained right before the final
      // `saveState`. Latest-wins semantics (Map.set keyed by logicalId)
      // means a CREATE / UPDATE later in the same deploy overwrites
      // the auto-refresh entry — no double-write to state. CREATEs for
      // brand-new resources skip this loop because they're not yet in
      // `currentState.resources`. Closes the upgrade UX gap left by
      // v3 schema: the manual `cdkd state refresh-observed` command
      // remains for non-deploy refresh.
      this.kickOffAutoRefreshObservedProperties(currentState.resources, currentState);

      // 2. Template parsing is handled by DagBuilder (dependency analysis) and
      // IntrinsicResolver (intrinsic function resolution) in later steps
      this.logger.debug(`Template has ${Object.keys(template.Resources || {}).length} resources`);

      // Issue #2740: the source the skipped-outputs digests are taken from,
      // snapshotted HERE — before `resolveParameters`, `evaluateConditions`
      // and every resolution below. A deep COPY, so that no resolution can be
      // visible to the digest however those steps are implemented: one that
      // could see a resolved value would both diverge from `cdkd diff`'s
      // digest (which snapshots at the same point of its own flow) and
      // fingerprint a decrypted secret into `state.json`. The invariant, and
      // why it does not rest on any one resolver's in-place behaviour, is in
      // `src/analyzer/skipped-outputs.ts`. `Resources` is dropped: the digest
      // never reads it, and it is the bulk of every template.
      const outputsDigestSource: CloudFormationTemplate = structuredClone({
        ...template,
        Resources: {},
      });

      // 2.5. Resolve parameters from template and user input
      // The inherited bag travels into `resolveParameters` as well as into the
      // per-resource contexts below (issue #1903 review round 2). This is the
      // seam where the PARENT's already-decrypted values first enter the child
      // engine, so it is where both the `--verbose` parameter lines are masked
      // and where a declared `Type` that would coerce the value out of cdkd's
      // string-keyed redaction model is refused.
      const parameterValues = await this.resolver.resolveParameters(
        template,
        this.options.parameters,
        {
          // `hasMaskableValues` (go-to-k/cdkd#1998): only the `--verbose`
          // lines read a bag holding log-only needles alone here; the
          // coercion refusal asks `size` itself.
          ...(this.options.inheritedSecrets &&
            hasMaskableValues(this.options.inheritedSecrets) && {
              inheritedSecrets: this.options.inheritedSecrets,
            }),
        }
      );
      this.logger.debug(
        `Resolved ${Object.keys(parameterValues).length} parameters: ${Object.keys(parameterValues).join(', ')}`
      );

      // 2.6. Evaluate conditions from template
      const context = this.buildResolverContext(
        {
          template,
          resources: currentState.resources,
          parameters: parameterValues,
        },
        stackName
      );
      const conditions = await this.resolver.evaluateConditions(context);
      this.logger.debug(
        `Evaluated ${Object.keys(conditions).length} conditions: ${Object.keys(conditions).join(', ')}`
      );
      // CloudFormation rejects an Output whose Value evaluates to
      // AWS::NoValue before it creates anything (issue #4077), so refuse it
      // here, before provisioning, rather than publishing nothing after it.
      refuseNoValueOutputs(template.Outputs, conditions);

      // 2.7. Prune resources whose `Condition:` key evaluated false (issue
      // #840). CFn does not strip condition-gated resources at synth time —
      // they sit in `Resources` with a `Condition:` key regardless of value,
      // and the deploy engine excludes them when the condition is false. From
      // here on the whole pipeline (type/property validation, DAG, diff,
      // provisioning) operates on this CFn-effective resource set, so a
      // condition-false resource that exists in prior state but is now absent
      // from the effective template flows through the diff's existing
      // "in state but not in desired -> DELETE" path (CFn removes it the same
      // way), and a condition-false resource is never created in the first
      // place.
      const effectiveTemplate = this.templateParser.filterResourcesByCondition(
        template,
        conditions
      );

      // 2b. Re-adopt anything a previous rollback left in AWS (issue #2934).
      //
      // Runs HERE — after condition pruning, before the diff — for two reasons
      // that are each load-bearing. The diff decides CREATE by absence from
      // state, so splicing a recorded resource back into `currentState`
      // produces an ordinary UPDATE with no new change type and no branch in
      // the create path. And it must read the PRUNED template: against the raw
      // one a resource under a false `Fn::If` reads as declared, gets adopted,
      // and is then seen by the diff as state-only — re-orphaning it WITHOUT
      // re-issuing a record, which loses the record permanently and is worse
      // than never adopting.
      //
      // `currentState.orphans` is mutated to the surviving set so every save
      // below persists it; the carried-forward spreads read this same object.
      const orphanCountBeforeAdoption = (currentState.orphans ?? []).length;
      const orphanPlan = await this.adoptRollbackOrphans(currentState, effectiveTemplate);
      // Issue #3468: an adopted record entered `resources` AFTER the deploy-start
      // stamp. No writer produces a marked orphan record today; re-reading here
      // keeps that from becoming load-bearing. Idempotent, and handed the same
      // `template` object as the first pass.
      if (Object.keys(orphanPlan.adopted).length > 0) {
        this.stampReasonlessParameterRefusals(currentState.resources, template);
      }
      // The no-change save below is gated on a fixed list of triggers, and
      // adoption trips none of them (issue #2934). Without this, a deploy whose
      // diff comes out entirely clean persists neither the resource the pre-pass
      // spliced in nor the record it consumed — so the stack keeps paying an
      // AWS existence read every run, forever, and `cdkd destroy` cannot delete
      // a resource that never reached the persisted `resources`.
      // Compared by COUNT, not by reference: `plan.remaining` is always a
      // fresh array, so identity would report a change on every deploy of a
      // stack that merely HOLDS a record — an S3 PUT and a `lastModified` bump
      // per run, forever, for a set that never moved. A count suffices because
      // the pre-pass only ADOPTS (which also lands in `plan.adopted`) or DROPS;
      // it never edits a kept record in place, so the two disjuncts below cover
      // every way the set can move.
      const orphansChanged =
        Object.keys(orphanPlan.adopted).length > 0 ||
        (currentState.orphans ?? []).length !== orphanCountBeforeAdoption;

      // 3. Validate resource types (before deployment starts)
      // Skip metadata resources as they don't actually deploy
      const resourceTypes = new Set(
        Object.values(effectiveTemplate.Resources || {})
          .map((r) => r.Type)
          .filter((type) => type !== 'AWS::CDK::Metadata')
      );
      this.providerRegistry.validateResourceTypes(resourceTypes);
      this.logger.debug(`All resource types validated`);

      // 3.5. Report top-level resource property routing decisions
      // (#614). For each resource using a silent-drop top-level property,
      // info-log that cdkd is auto-routing it via Cloud Control (which
      // forwards the full property map). For each resource explicitly
      // opted out via `--allow-unsupported-properties Type:Prop`, warn
      // that the silent drop has been accepted. Neither of those throws —
      // the legacy PR #608 fail-fast was reversed by #614 to a default-on
      // auto-route — but this step CAN still refuse, and the comment said
      // it could not until issue #3028. A drop on a type the Cloud Control
      // route cannot serve (`hasNoCloudControlHandlers`, or a provider declaring
      // `disableCcApiFallback`) has nowhere to be auto-routed, so
      // `ProviderRegistry.reportSilentDropDecisions` throws rather than
      // letting the route fail later with an opaque error. That refusal
      // lands HERE — ahead of the DAG at step 4 and the diff at step 5 —
      // so the deploy ends having provisioned nothing. Skips
      // AWS::CDK::Metadata (filtered by the same predicate as the type
      // set).
      const resourcesForPropertyCheck = Object.entries(effectiveTemplate.Resources || {})
        .filter(([, r]) => r.Type !== 'AWS::CDK::Metadata')
        .map(([logicalId, r]) => ({
          logicalId,
          resourceType: r.Type,
          properties: r.Properties,
          // Thread the state-recorded routing layer so already-sticky CC
          // resources demote the info-log to debug (avoids "routing via
          // Cloud Control API" repeated on every redeploy).
          provisionedBy: currentState.resources[logicalId]?.provisionedBy,
          // The baseline an unrecognized property is compared against, so the
          // routing lines describe the route `getProviderFor` takes (#3713).
          previousProperties: currentState.resources[logicalId]?.properties,
        }));
      this.providerRegistry.validateResourceProperties(resourcesForPropertyCheck);
      this.logger.debug(`All resource properties validated`);

      // 4. Build dependency graph
      const dag = this.dagBuilder.buildGraph(effectiveTemplate);
      const executionLevels = this.dagBuilder.getExecutionLevels(dag);
      this.logger.debug(`Dependency graph: ${executionLevels.length} execution levels`);

      // 5. Calculate diff
      // Pass a best-effort resolver so that changes hidden inside intrinsics (e.g.
      // `Fn::Join` literal args like "-value" -> "-value2") are detected against
      // the already-resolved values stored in state.
      const diffResolverContext = this.buildResolverContext(
        {
          template: effectiveTemplate,
          resources: currentState.resources,
          // The DIFF side binds the REDACTED parameter bag on a nested-stack
          // child (issue #1903). The provisioning contexts below deliberately
          // keep `parameterValues` — the real values are what reach AWS — and
          // so does the condition evaluation above, where substituting an
          // expression would flip an `Fn::Equals` over a parameter. See
          // `redactParametersForDiff`.
          parameters: this.redactParametersForDiff(parameterValues),
          conditions,
        },
        stackName
      );
      // The diff-phase resolution is best-effort (the calculator catches
      // failures and keeps the raw intrinsic): a Ref to a resource this
      // same deploy will CREATE is the expected case, so the resolver logs
      // it at debug, not warn (issue #1017). The provisioning-phase
      // resolver contexts do NOT set this — there, an unresolvable Ref is
      // a genuine error signal.
      diffResolverContext.bestEffort = true;
      // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED for the
      // diff (GHSA fix): state now stores the unresolved expression, so
      // comparing the desired side as its expression too avoids a spurious
      // perpetual UPDATE on every deploy of a secret-bearing resource, and
      // fetches no secret value at plan time. `cdkd diff --recursive` sets the
      // same flag when it resolves a nested child's input `Parameters`
      // (`resolveChildStackParameters`) — as of issue #1903, together with the
      // child-state half that makes the comparison self-consistent; setting it
      // there alone would have compared an expression against a child state
      // still holding plaintext. A changed expression still diffs.
      // An `ssm` reference is classified by the parameter's TYPE rather than by
      // its spelling (issue #1901), so unlike the secretsmanager case the diff
      // DOES issue one `GetParameter` per not-yet-classified reference — with
      // `WithDecryption: false`, so a `SecureString` never yields plaintext
      // here, while a `String` / `StringList` keeps resolving as the public
      // config state stores resolved.
      diffResolverContext.skipDynamicReferences = true;
      const diffResolveFn = (value: unknown) => this.resolver.resolve(value, diffResolverContext);
      const changes = await this.diffCalculator.calculateDiff(
        currentState,
        effectiveTemplate,
        diffResolveFn,
        // Shared with `cdkd diff` (issue #1591): a preview that narrows
        // differently from the apply forecasts a change the deploy will never
        // make, which is this issue's own bug class moved one command over.
        makeCanonicalizePropertiesFn(this.providerRegistry),
        // Issue #2750: the drops THIS deploy opted into via
        // `--allow-unsupported-properties` are not written, so comparing them
        // would report a change the SDK route will never make. `cdkd diff`
        // passes nothing here and that is correct — it registers no such flag,
        // so its preview is of a FLAG-LESS deploy, which is the one that
        // auto-routes and does write the property.
        //
        // Optional call for the TEST DOUBLES only. Many unit files hand-build
        // a registry object literal and cast it in; an unconditional call
        // failed 39 test FILES / 270 cases across `tests/unit/{deployment,cli}`
        // when measured, which is a count of what BROKE, not a survey of the
        // doubles. The sibling `makeCanonicalizePropertiesFn` survives them
        // only because it defers its registry reads into a closure the mocked
        // DiffCalculator never invokes. `undefined` degrades to "no flag",
        // which is what every one of those doubles means. The real class
        // always has the method — `providerRegistry` is typed as the concrete
        // class, so the `undefined` branch is unreachable in production, and
        // the method's existence is pinned directly on `ProviderRegistry` by
        // `provider-registry-report-silent-drops.test.ts`, since a mocked
        // registry cannot witness the real one losing it.
        this.providerRegistry.getAllowedUnsupportedProperties?.(),
        // go-to-k/cdkd#3717: a nested child's parameters carrying a `NoEcho`
        // value the parent supplied in THIS deploy. The diff side binds the
        // redacted bag above, where such a value is `***` like its record, so
        // the calculator promotes each reader instead.
        this.freshNoEchoParameters(parameterValues),
        // go-to-k/cdkd#4049: the diff pass resolves a `Ref` to a `NoEcho`
        // parameter to its plaintext and records it as a log-only needle of
        // THIS context's bag, so the calculator's replacement line masks with
        // it (and with a nested child's inherited bag). Printing only: the
        // changes it returns are unmasked.
        this.diffLogMasker(
          diffResolverContext.recordedSecretValues,
          effectiveTemplate,
          parameterValues
        )
      );
      // The diff was the prefetch's only consumer: withdraw what it did not
      // need, so it stops spending the account's DescribeType quota that the
      // deploy's own (write-only) lookups draw on.
      createOnlyPrefetch.cancel();

      // Issue #2668: refuse a Type change into or out of
      // `AWS::CloudFormation::Stack` before anything is provisioned. Every
      // other Type change is replaced normally — the old half routes on the
      // state record's type, the create on the template's — but for this pair
      // correct routing is not sufficient: the replacement's cleanup delete is
      // warn-and-continue, which for a nested row strands a whole child stack.
      // Full reasoning, and why there is no override, in
      // `type-change-guard.ts`.
      //
      // Placed HERE rather than in a CLI pre-flight for two reasons: nested
      // child stacks get their own `DeployEngine` from
      // `NestedStackProvider.runChildDeploy` and never pass through
      // `deploy.ts`, and this is the site that owns the very `changes` map the
      // routing decision is made from, so a pre-flight would have to
      // re-implement the diff's Type-change rule and could drift from it. It
      // is still before every provider call — and before the `--dry-run`
      // return below, so a dry run reports the refusal instead of previewing a
      // plan cdkd will not run. The lock acquired above is released by this
      // block's `finally`.
      const nestedStackTypeChanges = findNestedStackTypeChanges({
        changes,
        stateResources: currentState.resources,
      });
      if (nestedStackTypeChanges.length > 0) {
        // `markNonRetryable` for the same reason as the sibling refusals in
        // this file: the verdict is computed from a state record and a template
        // type, which no retry can change, while the message interpolates
        // TEMPLATE-CONTROLLED text (a logical id, the stack name, both type
        // strings, a physical id) into a string the SUBSTRING-matching
        // classifiers read.
        //
        // LATENT today, and deliberately marked anyway — the #1778 precedent,
        // and the same status `nested-stack-provider.ts` records for its own
        // mark. No claim is made here about WHICH loop would observe it:
        // two successive revisions of this comment named a loop that turned
        // out unreachable, so the honest statement is the one the mark itself
        // makes. `retry.ts` consults `isMarkedNonRetryable` ahead of
        // `opts.isRetryable`, so the DECLARATION survives any caller that
        // later opts back into retrying this path, which a message-only
        // classifier could not.
        throw markNonRetryable(
          new CdkdError(
            renderNestedStackTypeChangeRefusal(nestedStackTypeChanges, stackName),
            'TYPE_CHANGE_NESTED_STACK'
          )
        );
      }

      const hasChanges = this.diffCalculator.hasChanges(changes);

      if (!hasChanges) {
        this.logger.info('No changes detected. Stack is up to date.');

        // The diff only inspects Resources, so an Outputs-only change (a new
        // Export added because a downstream stack now references this one — its
        // Resources stay identical) lands here with hasChanges=false. If we
        // early-returned without persisting, the new export would never be
        // written to state / the exports index and the consumer's subsequent
        // Fn::ImportValue would fail (issue #875). So in the no-change path we
        // also resolve the template outputs against current state and persist
        // them when they differ — alongside the existing observed-properties
        // refresh (e.g. a v2 → v3 schema upgrade on a stack with nothing to
        // deploy). Both are skipped in dry-run.
        let persistedOutputs: Record<string, unknown> = currentState.outputs ?? {};
        if (!this.options.dryRun) {
          // Resolve against `effectiveTemplate` (condition-pruned) — the same
          // map the executeDeployment path resolves. Outputs reference
          // resources, which come from `currentState.resources` (the arg), and
          // condition pruning only touches `Resources`, so resolving against
          // `effectiveTemplate` vs the raw `template` is equivalent here.
          const resolvedOutputs = this.redactOutputs(
            // One budget for the whole pass, as on the deploy path above.
            await withSharedDrainBudget(() =>
              this.resolveOutputs(
                effectiveTemplate,
                currentState.resources,
                stackName,
                outputsDigestSource,
                parameterValues,
                conditions
              )
            )
          );
          // Drain any auto-refresh readCurrentState calls (drainObservedCaptures
          // short-circuits on an empty map) so the refreshed observed-properties
          // baseline lands in the same save. Drained BEFORE the outputs bag is
          // decided (issue #2771): it is the one await between the outputs pass
          // and the save, and a secret a released outputs-pass part records
          // during it must be visible to the save-time check below.
          const observedRefresh = (await this.drainObservedCaptures(currentState.resources)) > 0;

          // Without `--strict-getatt`, resolveOutputs stores `undefined` for any
          // output it could not resolve (warned about there when the resolver
          // threw, silently when it returned nothing); with the flag it throws
          // for either instead. In the no-change path every resource is
          // already in state so resolution usually succeeds.
          const resolutionFailed = Object.values(resolvedOutputs).some((v) => v === undefined);
          const currentEffectiveExports = new Set(importableOutputKeys(currentState));
          // Issue #2771: when one did not, persist what DID resolve instead of
          // keeping the previous bag whole. A failed key keeps its stored value
          // (the #875 guard: never overwrite a good value with nothing), a key
          // this pass did not produce is removed, and the shapes the merge
          // cannot do safely keep the whole previous bag as before. The rules
          // and the refusals are in `no-change-outputs-merge.ts`.
          let merge: NoChangeOutputsMerge | undefined = resolutionFailed
            ? mergeNoChangeOutputs({
                persisted: persistedOutputs,
                resolved: resolvedOutputs,
                declaredOutputs: effectiveTemplate.Outputs,
                previousExportNames: currentEffectiveExports,
                resolvedExportNames: this.resolvedExportNames,
              })
            : undefined;
          // Today's template may position only the keys THIS pass wrote. The save
          // redacts the bag again (`withParentInfo` -> `redactOutputs`), and
          // `redactByPath` returns a source leaf that is a whole secret expression
          // verbatim — so a carried key, or a whole kept bag, positioned by
          // today's template would be persisted as a reference its stored value
          // never came from. Those keys fall to the value scan instead.
          if (merge?.kind === 'merged') {
            for (const key of merge.carriedKeys) {
              Reflect.deleteProperty(this.outputsTemplateSource, key);
            }
            // The merge's own mixed-generation check read the bag BEFORE this
            // save's redaction, which can still give it a first expression (a
            // needle recorded late, during the drain above). Re-read it as the
            // save will write it. No await separates this check from the
            // save's own redaction below.
            if (
              merge.carriedKeys.length > 0 &&
              !bagHoldsSecretExpression(persistedOutputs) &&
              bagHoldsSecretExpression(this.redactOutputs(merge.outputs))
            ) {
              merge = { kind: 'kept', reason: 'mixed-generation' };
            }
          }
          if (merge?.kind === 'kept') this.outputsSourceUsable = false;
          // The bag and export set this save describes: this pass's when every
          // output resolved, the merge's when one did not, and the previous
          // bag itself when the merge keeps it whole — `undefined` for the set
          // then, because its own set travels with it (below). No separate
          // kept-whole guard on `outputsChanged`: a kept bag IS
          // `persistedOutputs`, so it compares equal by construction.
          const outputsToPersist =
            merge === undefined
              ? resolvedOutputs
              : merge.kind === 'merged'
                ? merge.outputs
                : persistedOutputs;
          const exportNamesToPersist: readonly string[] | undefined =
            merge === undefined
              ? this.resolvedExportNames
              : merge.kind === 'merged'
                ? merge.exportNames
                : undefined;
          const outputsChanged = !outputMapsEqual(persistedOutputs, outputsToPersist);
          // Issue #2193: the EFFECTIVE export set can change without the outputs
          // VALUES changing, and the no-change path is the only place that would
          // persist it. Two shapes reach here with `outputsChanged` false:
          //   - a pre-v9 record (`exportNames` undefined) still feeding the index
          //     every plain Output name — the legacy every-key set differs from
          //     the resolved exports whenever there is a plain name to suppress;
          //   - a SELF-NAMED export toggled on a v9 record: adding
          //     `Export: { Name: <same-as-output-key> }` (or removing it) rewrites
          //     the same key with the same value, so the bag is byte-equal, but
          //     `exportNames` flips between `[]` and `[<key>]`. Without this the
          //     added export never lands in state/index (consumer's Fn::ImportValue
          //     hard-fails), and the removed one is a phantom export served forever.
          // Detect it by comparing the CURRENTLY-effective set against the set
          // this save would write. Subsumes the old pre-v9 backfill and catches
          // both self-named directions. Kept OUT of `outputsChanged` deliberately:
          // this is not an outputs-VALUE change, so it must not flip the
          // "Outputs-only change" log or the bag choice. Never set when the
          // previous bag is kept whole: its own set is carried with it.
          const persistExportSet = new Set(exportNamesToPersist ?? []);
          const exportSetChanged =
            exportNamesToPersist !== undefined &&
            (currentEffectiveExports.size !== persistExportSet.size ||
              [...persistExportSet].some((k) => !currentEffectiveExports.has(k)));

          // Surface the case where outputs DID change but the merge refused and
          // the previous bag was kept whole. resolveOutputs already warns
          // per-output, but a call-site summary makes the "deploy reports
          // no-change yet a new export silently failed to land" path explicit
          // (a downstream Fn::ImportValue would otherwise break later with no
          // obvious link back to this deploy). The merged arm needs no such
          // line: everything that resolved is persisted, an output whose
          // resolver threw already has its own warning, and one whose resolver
          // returned nothing is silent here as it is on every path without
          // `--strict-getatt` (which fails the deploy for it before this
          // point) — the #2740 record still names it.
          if (merge?.kind === 'kept' && !outputMapsEqual(persistedOutputs, resolvedOutputs)) {
            this.logger.warn(
              'Outputs changed but one or more could not be resolved; keeping the previously ' +
                `persisted outputs. ${keptWholeReasonText(merge.reason)} ` +
                'A downstream Fn::ImportValue may fail until the next deploy.'
            );
          } else if (merge?.kind === 'merged' && merge.carriedKeys.length > 0) {
            this.logger.debug(
              `Kept the previously persisted value of ${merge.carriedKeys.length} output key(s), ` +
                'carried export aliases included, that could not be resolved (no-change path, #2771)'
            );
          }

          // Issue #2740: the skipped-outputs record needs its OWN trigger on
          // this path. The shape that produces it — an output failing inside
          // a secret lookup on a stack with no resource diff — lands here
          // with `resolutionFailed` true, and `outputsChanged` /
          // `exportSetChanged` stay false whenever the bag this save would
          // write equals the stored one (the usual case: the skipped key was
          // never stored) or the previous bag is kept whole, so without this
          // the field would never be written for exactly the case it exists
          // for. A difference in either direction saves: a key newly skipped
          // (or its digest moved), or one that resolved / left the template
          // and must be cleared. Also the upgrade path — a record with no
          // field yet whose broken output is skipped again today.
          const skippedOutputsChanged = !skippedOutputsEqual(
            currentState.skippedOutputs,
            this.skippedOutputs
          );

          // Issue #1852: a heal the outputs pass (or the diff pass above) read
          // must reach state even when nothing else changed. Otherwise every
          // later deploy pays the same read again, `cdkd diff` repeats it on
          // every run (its healer is read-only and saves nothing,
          // go-to-k/cdkd#3456), and `cdkd drift`, which re-reads nothing,
          // never sees the attribute at all.
          const healedAttributesPending = this.hasUnpersistedHeals(currentState.resources);

          if (
            observedRefresh ||
            outputsChanged ||
            exportSetChanged ||
            skippedOutputsChanged ||
            orphansChanged ||
            healedAttributesPending
          ) {
            try {
              const refreshedState: StackState = {
                version: STATE_SCHEMA_VERSION_CURRENT,
                region: this.stackRegion,
                stackName: currentState.stackName,
                resources: currentState.resources,
                ...orphansCarriedFrom(currentState),
                outputs: (outputsChanged ? outputsToPersist : persistedOutputs) as Record<
                  string,
                  string
                >,
                // The set belongs to the bag written above: this pass's when
                // every output resolved (changed, or equal — either way the
                // resolved set describes it), the merge's when one did not, and
                // the previous record's when the previous bag was kept whole.
                ...(exportNamesToPersist === undefined
                  ? exportNamesCarriedFrom(currentState)
                  : { exportNames: [...exportNamesToPersist] }),
                // Unlike `exportNames`, ALWAYS this pass's: the record says
                // what THIS deploy skipped, which the resolution just decided
                // whether or not the bag was carried forward. Omitted when
                // nothing was skipped. COPIED, like the `exportNames` /
                // `imports` spreads beside it. Consistency, not a fix for an
                // observable bug: `collectSkippedOutputs` builds a FRESH
                // object each pass, so no alias outlives one and no test can
                // tell a copy from an alias here. Stated so the absence of a
                // fence is not read as an oversight.
                ...(this.skippedOutputs && { skippedOutputs: { ...this.skippedOutputs } }),
                // Preserve existing imports[] / outputReads[] (v8+) — otherwise
                // the refresh would silently strip the strong-reference record
                // on every diff-clean deploy. Unioned with this session's
                // records rather than taking the snapshot alone (issue #2057):
                // the no-change path resolves nothing new in the common case,
                // so the union is usually an identity, and applying one rule at
                // every non-success save leaves no exception to remember. See
                // `crossStackReadsForPartialSave`.
                ...crossStackReadsForPartialSave(
                  currentState,
                  this.recordedImports,
                  this.recordedOutputReads,
                  this.crossStackReadKeyNormalizer()
                ),
                lastModified: Date.now(),
              };
              const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {};
              if (currentEtag !== undefined) saveOptions.expectedEtag = currentEtag;
              if (migrationPending) saveOptions.migrateLegacy = true;
              await this.stateBackend.saveState(
                stackName,
                this.stackRegion,
                this.withParentInfo(refreshedState),
                saveOptions
              );
              if (outputsChanged || exportSetChanged) {
                persistedOutputs = refreshedState.outputs;
                if (outputsChanged) {
                  this.logger.info('Persisted Outputs-only change (no resource diff).');
                } else {
                  this.logger.debug(
                    'Persisted export-set change (no outputs-value diff, no-change path, #2193)'
                  );
                }
                // Update the persistent exports index so the newly-added export
                // resolves O(1) for consumers — with the EXPORTS only (#2193),
                // which on the backfill arm is what evicts the plain-name
                // entries a pre-v9 deploy published. Inside the try so a failed
                // state save doesn't publish an export that wasn't persisted;
                // updateForStack is itself best-effort (swallows + warns).
                if (this.exportIndexStore) {
                  await this.exportIndexStore.updateForStack(
                    stackName,
                    this.stackRegion,
                    // Redacted again as the save above redacts it (issue
                    // #2814), so this path's index cannot diverge from what
                    // state holds. Since issue #2771 the call is load-bearing
                    // rather than only fail-safe: a released drain leaves an
                    // output unresolved, and the partial persist then writes
                    // the SIBLINGS that did resolve, so a needle a released
                    // part records after the outputs pass CAN reach this
                    // block. (The bag is not always this pass's either: on the
                    // `exportSetChanged`-only arm it is `persistedOutputs`,
                    // the PREVIOUS deploy's bag, and a second pass is not
                    // unconditionally idempotent; see
                    // `absorbOutputsPassSecrets`.) A needle arriving between
                    // the save and this call leaves the index more redacted
                    // than state, never less.
                    importableOutputs({
                      ...refreshedState,
                      outputs: this.redactOutputs(refreshedState.outputs),
                    })
                  );
                }
              } else if (observedRefresh) {
                this.logger.debug('Persisted refreshed observedProperties (no-change path)');
              } else if (healedAttributesPending) {
                this.logger.debug(
                  'Persisted attributes re-read from AWS for a stale record (no-change path, #1852)'
                );
              } else {
                this.logger.debug(
                  'Persisted skipped-outputs record (no outputs-value diff, no-change path, #2740)'
                );
              }
            } catch (saveError) {
              this.logger.warn(
                `Failed to persist no-change state update: ${saveError instanceof Error ? saveError.message : String(saveError)} — drift baseline / outputs will be re-resolved on next deploy.`
              );
            }
          }
        }

        // A clean no-change deploy is still a SUCCESSFUL deploy — drop any
        // lingering rollback journal, matching the documented "deleted on
        // the next successful deploy" contract (the changes path does this
        // at its end too). This matters for the failed-only segment a clean
        // auto-rollback retains (issue #1208): the typical fix-forward is
        // REMOVING the failed resource from the template, which lands here
        // with hasChanges=false — without this delete the journal (and its
        // "previous deploy failed" note) would linger indefinitely.
        if (!this.options.dryRun) {
          await this.settleJournalAfterSuccess(
            stackName,
            [],
            currentState,
            currentState.resources,
            currentEtag === undefined
          );
        }

        return {
          stackName,
          created: 0,
          updated: 0,
          deleted: 0,
          deleteSkipped: 0,
          updatePartial: 0,
          unchanged: Object.keys(currentState.resources).length,
          durationMs: Date.now() - startTime,
          // Redacted again, as the save redacts the bag it writes (issue
          // #2814): a part the drain cap stopped waiting for can record after
          // the outputs pass, and the bag kept here may be the PREVIOUS
          // deploy's, holding a literal nothing resolved then.
          outputs: this.buildDisplayOutputs(template, this.redactOutputs(persistedOutputs)),
          attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
        };
      }

      // Log changes summary
      const createChanges = this.diffCalculator.filterByType(changes, 'CREATE');
      const updateChanges = this.diffCalculator.filterByType(changes, 'UPDATE');
      const deleteChanges = this.diffCalculator.filterByType(changes, 'DELETE');

      this.logger.info(
        `Changes: ${green(createChanges.length)} to create, ${yellow(updateChanges.length)} to update, ${red(deleteChanges.length)} to delete`
      );

      if (this.options.dryRun) {
        this.logger.info('Dry run mode - skipping actual deployment');
        return {
          stackName,
          created: createChanges.length,
          updated: updateChanges.length,
          deleted: deleteChanges.length,
          // A dry run issues no provider call, so nothing can be skipped.
          deleteSkipped: 0,
          updatePartial: 0,
          unchanged: this.diffCalculator.filterByType(changes, 'NO_CHANGE').length,
          durationMs: Date.now() - startTime,
          attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
        };
      }

      // Issue #1111 item 3 (review fix): the diff phase above resolves
      // intrinsics through the SAME counted resolver, so a warn-path
      // fallback on a to-be-updated resource would otherwise count once
      // during diff and AGAIN during provisioning (~2x distinct sites in
      // the summary). Reset here so the change-path summary counts each
      // fallback site once (provisioning + final output resolution). The
      // no-change / dry-run early returns above keep the deploy()-start
      // reset: their only resolutions ARE the diff phase (+ the no-change
      // path's output resolution), so nothing double-counts there. Full
      // semantics in the counter's JSDoc
      // ({@link IntrinsicFunctionResolver.getPhysicalIdFallbackCount}).
      this.resolver.resetPhysicalIdFallbackCount();

      // Progress counter for tracking overall deployment progress
      const totalOperations = createChanges.length + updateChanges.length + deleteChanges.length;
      const progress = { current: 0, total: totalOperations };

      // 6. Execute deployment (event-driven DAG dispatch with partial state saves)
      const {
        state: newState,
        actualCounts,
        completedOperations,
      } = await withProducerRegions(
        // go-to-k/cdkd#4174: for the child engine a nested-stack row builds.
        () => this.producerRegionEvidence(currentState),
        () =>
          this.executeDeployment(
            effectiveTemplate,
            currentState,
            changes,
            dag,
            executionLevels,
            stackName,
            outputsDigestSource,
            parameterValues,
            conditions,
            currentEtag,
            progress,
            migrationPending
          )
      );

      // 7a. Drain in-flight readCurrentState promises so each resource's
      // observedProperties lands in newState before we persist it. By
      // this point the deploy critical path is over, so awaiting the
      // remaining captures only adds the longest still-pending read
      // (typically <300ms in practice for medium stacks; see PR notes).
      await this.drainObservedCaptures(newState.resources);

      // A part the drain cap stopped waiting for can record its secret after
      // the outputs pass redacted `newState.outputs`, and the drain above is
      // a real wait (issue #2814). The save below needs nothing extra for
      // it: `withParentInfo` redacts the outputs again, and `redactOutputs`
      // re-reads the pass map first. The exports index and the deploy
      // summary read `newState` after the save's own await, so each redacts
      // it again at that moment, against the recordings available then. That
      // is not a promise they equal the saved copy: a record arriving during
      // the save's await reaches them, while the save had already taken its
      // copy.

      // 7b. Save final state (ETag may have been updated by partial saves).
      // The legacy migration delete (when migrationPending) was already done by
      // the first per-resource save inside executeDeployment, so this final
      // save is unconditionally region-scoped.
      const newEtag = await this.stateBackend.saveState(
        stackName,
        this.stackRegion,
        this.withParentInfo(newState)
      );
      this.logger.debug(`State saved (ETag: ${newEtag})`);

      // 7c. Two independent post-save S3 writes, run CONCURRENTLY:
      //
      //   1. Delete the rollback journal. Deploy succeeded, so the stable
      //      baseline has moved and a journal from a prior failed attempt
      //      (fix-forward that now succeeded) must NOT be replayable past
      //      this point (issue #1183). Best-effort.
      //   2. Update the persistent exports index with this stack's outputs
      //      so subsequent `Fn::ImportValue` resolves hit O(1). Best-effort:
      //      failures are swallowed inside updateForStack and surfaced as
      //      warnings (state.json is canonical; a stale index self-heals on
      //      the next deploy/resolve fallback).
      //
      // They target DISJOINT S3 objects — `{prefix}/{stack}/{region}/
      // rollback-journal.json` vs the bucket-level exports index — and
      // neither reads what the other writes: `updateForStack` only ever
      // touches the exports index (plus, on a first-ever call, a rebuild
      // scan of `state.json` files, which the journal delete does not
      // affect), and the journal delete reads nothing at all. So the
      // previous sequential ordering carried no dependency; it was costing
      // a full extra S3 round trip on every successful deploy (measured
      // ~0.5s of the ~1.0s "State saved" -> "Lock released" window).
      //
      // BOTH stay strictly AFTER the state save above and strictly BEFORE
      // the lock release in the `finally` below, which is load-bearing:
      // deleting the journal before the new baseline is durable would lose
      // the ability to revert, and releasing the lock before these settle
      // would let a concurrent deploy of the same stack observe a journal
      // we are about to delete (spurious "a previous deploy failed" note)
      // or race the exports-index read-modify-write.
      await Promise.all([
        this.settleJournalAfterSuccess(
          stackName,
          completedOperations,
          currentState,
          newState.resources,
          currentEtag === undefined
        ),
        this.exportIndexStore
          ? this.exportIndexStore.updateForStack(
              stackName,
              this.stackRegion,
              // The EXPORTS only (issue #2193): the bag also holds every plain
              // Output name, and an index fed the whole bag served those to
              // `Fn::ImportValue` — a same-named plain Output in an unrelated
              // stack could shadow a real export.
              importableOutputs({
                ...newState,
                outputs: this.redactOutputs(newState.outputs),
              })
            )
          : Promise.resolve(),
      ]);

      const durationMs = Date.now() - startTime;
      const unchangedCount =
        this.diffCalculator.filterByType(changes, 'NO_CHANGE').length + actualCounts.skipped;

      return {
        stackName,
        created: actualCounts.created,
        updated: actualCounts.updated,
        deleted: actualCounts.deleted,
        deleteSkipped: actualCounts.deleteSkipped,
        updatePartial: actualCounts.updatePartial,
        unchanged: unchangedCount,
        durationMs,
        outputs: this.buildDisplayOutputs(template, this.redactOutputs(newState.outputs ?? {})),
        attributeFallbackCount: this.resolver.getPhysicalIdFallbackCount(),
      };
    } finally {
      // Stop live renderer (clears any remaining in-flight task display).
      //
      // Guarded for the same reason `start()` moved inside the `try` above
      // (issue #2171): `stop()` writes to stdout, and it is the FIRST statement
      // of the `finally` that releases the lock — a throw here would abort the
      // teardown before `releaseLock` and re-open the strand one line later.
      try {
        renderer.stop();
      } catch {
        // Deliberately silent: the whole point is that the stdout channel is
        // failing, so logging the failure through it is another throw on the
        // same pre-`releaseLock` path.
      }

      // Remove SIGINT handler.
      //
      // This unregisters BEFORE the lock release further down, which is the
      // ordering `destroy-runner.ts` (issues #2053 / #1952) and `rollback.ts`
      // (issue #2118) were both corrected AWAY from — so the last remaining
      // instance owes an explanation. It is safe HERE for a reason neither of those had:
      // `deploy.ts` registers its own top-level SIGINT handler that outlives
      // this whole method, so the process is never left with zero listeners
      // while the lock is held. `destroy.ts` / `state.ts` register none, which
      // is exactly why the same shape was a stranded lock there.
      //
      // If that top-level handler is ever removed or made conditional, this
      // block has to be reordered to release first.
      process.removeListener('SIGINT', sigintHandler);

      // On a rollback / SIGINT exit we may leave in-flight readCurrentState
      // promises in the map (the success path drains them above). Clear the
      // map so a re-used engine instance does not accumulate stale entries
      // across deploys. The underlying promises already have a `.catch` so
      // dropping the references will not produce an unhandled rejection.
      this.observedCaptureTasks.clear();

      // Always release lock
      try {
        await this.lockManager.releaseLock(stackName, this.stackRegion);
        this.logger.debug('Lock released');
      } catch (lockError) {
        this.logger.warn(
          `Failed to release lock: ${lockError instanceof Error ? lockError.message : String(lockError)}`
        );
      }
    }
  }

  /**
   * Execute deployment by processing resources via event-driven DAG dispatch.
   *
   * - CREATE/UPDATE follow forward dependency order (a node starts as soon as
   *   ALL of its dependencies are completed — does not wait for unrelated
   *   siblings in the same "level")
   * - DELETE follows reverse dependency order (a node starts as soon as all
   *   resources that depend ON it have finished deleting)
   */
  private async executeDeployment(
    template: CloudFormationTemplate,
    currentState: StackState,
    changes: Map<string, ResourceChange>,
    dag: ReturnType<DagBuilder['buildGraph']>,
    executionLevels: string[][],
    stackName: string,
    /** The pre-resolution snapshot for the skipped-outputs digests (issue #2740); see `doDeploy`. */
    outputsDigestSource: CloudFormationTemplate,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>,
    currentEtag?: string,
    progress?: { current: number; total: number },
    migrationPending = false
  ): Promise<{
    state: StackState;
    actualCounts: ProvisionCounts;
    /** Issue #3754: journaled by a NESTED engine on success. */
    completedOperations: CompletedOperation[];
  }> {
    const concurrency = this.options.concurrency!;
    this.deployChanges = changes;
    const newResources: Record<string, ResourceState> = { ...currentState.resources };
    const actualCounts: ProvisionCounts = {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      deleteSkipped: 0,
      updatePartial: 0,
    };
    const completedOperations: CompletedOperation[] = [];
    // #1198: the op(s) that FAILED mid-deploy (usually one; concurrent
    // siblings can add more). Journaled alongside completedOperations so
    // `cdkd rollback --revert-failed` can optionally revert them.
    const failedOperations: FailedOperation[] = [];
    // Tracked here so the FIRST per-resource save sweeps the legacy key; we
    // don't want to delete it on every save.
    let pendingMigration = migrationPending;

    // Serialize per-resource state saves to avoid ETag conflicts from concurrent writes
    let saveChain: Promise<void> = Promise.resolve();
    const saveStateAfterResource = (logicalId: string): void => {
      if (currentEtag === undefined) return;
      saveChain = saveChain.then(async () => {
        try {
          const partialState: StackState = {
            version: STATE_SCHEMA_VERSION_CURRENT,
            region: this.stackRegion,
            stackName: currentState.stackName,
            resources: newResources,
            outputs: currentState.outputs,
            ...exportNamesCarriedFrom(currentState),
            ...skippedOutputsCarriedFrom(currentState),
            ...orphansCarriedFrom(currentState),
            // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
            // session resolved. See `crossStackReadsForPartialSave` — writing the
            // snapshot alone left a failed deploy's persisted record denying a
            // cross-stack read its own resources were built from.
            ...crossStackReadsForPartialSave(
              currentState,
              this.recordedImports,
              this.recordedOutputReads,
              this.crossStackReadKeyNormalizer()
            ),
            lastModified: Date.now(),
          };
          // Migration is a one-shot tail on the first save; subsequent saves
          // overwrite the new key in-place under optimistic locking.
          const migrate = pendingMigration;
          const expectedEtag = migrate ? undefined : currentEtag;
          currentEtag = await this.stateBackend.saveState(
            stackName,
            this.stackRegion,
            this.withParentInfo(partialState),
            { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
          );
          if (migrate) pendingMigration = false;
          this.logger.debug(`State saved after ${logicalId}`);
        } catch (error) {
          this.logger.warn(
            `Failed to save state after ${logicalId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
    };

    // Separate DELETE operations from CREATE/UPDATE
    const deleteChanges = new Set(
      Array.from(changes.entries())
        .filter(([_, change]) => change.changeType === 'DELETE')
        .map(([logicalId]) => logicalId)
    );

    try {
      // Step 1: Process CREATE/UPDATE via event-driven DAG dispatch.
      // A node starts as soon as ALL of its dependencies are completed, rather
      // than waiting for an entire "level" of unrelated siblings to finish.
      const createUpdateIds: string[] = [];
      for (const [id, change] of changes.entries()) {
        if (deleteChanges.has(id)) continue;
        if (change.changeType === 'NO_CHANGE') continue;
        createUpdateIds.push(id);
      }

      if (createUpdateIds.length > 0) {
        this.logger.info(
          `${cyan('Deploying')} ${cyan(createUpdateIds.length)} resource(s) (DAG: ${executionLevels.length} levels, max parallel: ${concurrency})`
        );

        const createUpdateExecutor = new DagExecutor<ResourceChange>();
        const provisionable = new Set(createUpdateIds);
        for (const id of createUpdateIds) {
          const allDeps = this.dagBuilder.getDirectDependencies(dag, id);
          // Only carry deps that are themselves being provisioned in this phase;
          // NO_CHANGE / DELETE / non-DAG deps are already satisfied.
          const deps = new Set(allDeps.filter((d) => provisionable.has(d)));
          createUpdateExecutor.add({
            id,
            dependencies: deps,
            state: 'pending',
            data: changes.get(id)!,
          });
        }

        try {
          await createUpdateExecutor.execute(
            concurrency,
            async (node) => {
              const logicalId = node.id;
              const change = node.data;

              const previousState = currentState.resources[logicalId]
                ? { ...currentState.resources[logicalId] }
                : undefined;

              try {
                await this.provisionResource(
                  logicalId,
                  change,
                  newResources,
                  stackName,
                  template,
                  parameterValues,
                  conditions,
                  actualCounts,
                  progress
                );
              } catch (provisionError) {
                // Signal interruption so that long-running operations (e.g., CloudFront
                // waitForDeployed) in sibling tasks abort promptly instead of blocking
                // until their own polling timeouts fire.
                this.interrupted = true;
                this.interruptCause ??= 'sibling-failure';
                // #1198: journal the failed op's pre-op state + attempted
                // properties so `cdkd rollback --revert-failed` can act on it.
                failedOperations.push({
                  logicalId,
                  changeType: change.changeType as 'CREATE' | 'UPDATE',
                  resourceType: change.resourceType,
                  provisionedBy:
                    newResources[logicalId]?.provisionedBy ?? previousState?.provisionedBy,
                  ...(previousState && { previousState }),
                  physicalId: newResources[logicalId]?.physicalId ?? previousState?.physicalId,
                  attemptedProperties: this.attemptedResolvedProps.get(logicalId),
                });
                throw provisionError;
              }

              completedOperations.push({
                logicalId,
                changeType: change.changeType as 'CREATE' | 'UPDATE',
                resourceType: change.resourceType,
                // Snapshot the routing layer just landed on the resource
                // (CREATE = the auto-route decision; UPDATE = the state's
                // sticky / re-evaluated layer). Threads into rollback so a
                // CC-routed CREATE rolls back via the CC delete path —
                // closing the silent-data-corruption hazard the v7 schema
                // bump was designed to prevent.
                provisionedBy:
                  newResources[logicalId]?.provisionedBy ?? previousState?.provisionedBy,
                previousState,
                physicalId: newResources[logicalId]?.physicalId,
                properties: newResources[logicalId]?.properties,
                // Issue #2603: the retain verdict this deploy ACTED ON, so the
                // rollback classifier stops re-deriving it from
                // `previousState.updateReplacePolicy` — a different source
                // that disagrees on exactly the deploy which adds or drops the
                // attribute. Stamped on every UPDATE, including a `false` for
                // a replacement that deleted the old resource: an ABSENT field
                // is what a pre-#2603 journal looks like, and the classifier
                // falls back to the old (wrong) read for those, so recording
                // only the `true` case would leave the DROP direction live.
                ...(change.changeType === 'UPDATE' && {
                  oldResourceRetained: this.retainedOldOnReplacement.has(logicalId),
                }),
                // Issue #2668: `resourceType` above is the TEMPLATE's type, so
                // on a Type change the journal would otherwise name only the
                // NEW one and the rollback would re-create the OLD resource
                // through the new type's provider. Stamped on every UPDATE that
                // has a previous record, for the reason `oldResourceRetained`
                // is: ABSENT then means "written by a binary that predates this
                // field" and nothing else.
                ...(change.changeType === 'UPDATE' &&
                  previousState !== undefined && {
                    previousResourceType: previousState.resourceType,
                  }),
              });

              saveStateAfterResource(logicalId);
            },
            () => this.interrupted
          );
        } finally {
          // Wait for any pending per-resource state saves before the next phase or
          // before propagating an error — prevents partial-save races.
          await saveChain;
        }

        // If SIGINT fired AND there is still un-provisioned work (some nodes
        // remained pending because dispatch was cancelled), surface it as an
        // explicit interruption so the catch path saves partial state.
        // If every node already completed before SIGINT landed, treat the deploy
        // as fully successful — matches the prior level-loop's "loop exits, no
        // check" behaviour at the very end of execution.
        if (this.interrupted && this.hasPending(createUpdateExecutor)) {
          throw new InterruptedError(this.interruptCause ?? 'user');
        }
      }

      // Step 2: Process DELETE operations in reverse dependency order.
      if (deleteChanges.size > 0) {
        this.logger.info(`${red('Deleting')} ${red(deleteChanges.size)} resource(s)`);

        const deleteDeps = this.buildDeletionDependencies(deleteChanges, currentState);
        const deleteExecutor = new DagExecutor<ResourceChange>();
        for (const id of deleteChanges) {
          deleteExecutor.add({
            id,
            dependencies: deleteDeps.get(id) ?? new Set(),
            state: 'pending',
            data: changes.get(id)!,
          });
        }

        try {
          await deleteExecutor.execute(
            concurrency,
            async (node) => {
              const logicalId = node.id;
              const change = node.data;

              const previousState = currentState.resources[logicalId]
                ? { ...currentState.resources[logicalId] }
                : undefined;

              let deleteOutcome: ResourceOutcomeSignal | void;
              try {
                deleteOutcome = await this.provisionResource(
                  logicalId,
                  change,
                  newResources,
                  stackName,
                  template,
                  parameterValues,
                  conditions,
                  actualCounts,
                  progress
                );
              } catch (provisionError) {
                this.interrupted = true;
                this.interruptCause ??= 'sibling-failure';
                // #1198: a failed DELETE leaves the resource in place — the
                // record documents it in the journal (no revert needed).
                failedOperations.push({
                  logicalId,
                  changeType: 'DELETE',
                  resourceType: change.resourceType,
                  provisionedBy: previousState?.provisionedBy,
                  ...(previousState && { previousState }),
                  physicalId: previousState?.physicalId,
                });
                throw provisionError;
              }

              // Issue #1762: a skipped DELETE is NOT a completed operation.
              // Journaling it would make `cdkd rollback` re-CREATE a resource
              // that was never deleted — colliding on its name at best, and
              // producing a second live copy at worst. The state record was
              // kept, so there is nothing to revert and nothing to persist
              // beyond what is already there.
              if (deleteOutcome) return;

              completedOperations.push({
                logicalId,
                changeType: 'DELETE',
                resourceType: change.resourceType,
                provisionedBy: previousState?.provisionedBy,
                previousState,
              });

              saveStateAfterResource(logicalId);
            },
            () => this.interrupted
          );
        } finally {
          await saveChain;
        }

        if (this.interrupted && this.hasPending(deleteExecutor)) {
          throw new InterruptedError(this.interruptCause ?? 'user');
        }
      }
    } catch (error) {
      // `initialDeploy` (issue #1183): the failed deploy was the FIRST deploy
      // (no prior state loaded). Captured BEFORE the partial-state save below,
      // which reassigns `currentEtag`. Recorded on the journal segment so
      // `cdkd rollback` deletes state.json entirely once everything is unwound.
      const initialDeploy = currentEtag === undefined;

      // Save partial state BEFORE rollback to track all successfully provisioned
      // resources (including those that completed concurrently with the one that
      // failed). This prevents orphaned resources — resources that exist in AWS
      // but not in the state file.
      try {
        const preRollbackState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: this.stackRegion,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          ...exportNamesCarriedFrom(currentState),
          ...skippedOutputsCarriedFrom(currentState),
          ...orphansCarriedFrom(currentState),
          // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
          // session resolved. See `crossStackReadsForPartialSave` — writing the
          // snapshot alone left a failed deploy's persisted record denying a
          // cross-stack read its own resources were built from.
          ...crossStackReadsForPartialSave(
            currentState,
            this.recordedImports,
            this.recordedOutputReads,
            this.crossStackReadKeyNormalizer()
          ),
          lastModified: Date.now(),
        };
        const migrate = pendingMigration;
        const expectedEtag = migrate ? undefined : currentEtag;
        currentEtag = await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(preRollbackState),
          { ...(expectedEtag !== undefined && { expectedEtag }), migrateLegacy: migrate }
        );
        if (migrate) pendingMigration = false;
        this.logger.debug('Partial state saved before rollback (orphaned resource tracking)');
      } catch (saveError) {
        this.logger.warn(
          `Failed to save partial state before rollback: ${saveError instanceof Error ? saveError.message : String(saveError)}`
        );
      }

      // Set true when an automatic rollback replayed with zero per-op
      // failures — gates the post-save journal deletion below.
      let autoRollbackClean = false;
      // Resources this deploy's rollback left in AWS under `DeletionPolicy: Retain`
      // (issue #2934). Stays empty when no rollback ran, so the saves below
      // spread nothing and a stack that never orphaned keeps a byte-identical
      // record.
      let rollbackOrphans: StackOrphanRecord[] = [];
      // The nested rows the automatic rollback actually reverted (issue
      // #3754): only their children's pending segments are settled with it.
      let rollbackSettledNested: SettledNestedRows = new Map();

      // On SIGINT, skip rollback — just save partial state, record a rollback
      // journal segment so the interrupted deploy is REVERTIBLE (not just
      // resumable), and let the caller exit.
      //
      // A user interrupt reaches this catch in three shapes, and all three must
      // take this branch — the other one rolls the stack back on a Ctrl-C:
      //
      //  - the engine's own `InterruptedError`, raised by its between-ops poll;
      //  - an `InterruptedWaitError` from a provider's wait, WRAPPED by the
      //    provider's `ProvisioningError` (issue #2040), which
      //    `isInterruptedWaitError` finds on the cause chain;
      //  - an `InterruptedError` WRAPPED by `provisionResource`'s own
      //    `ProvisioningError`: one raised by this engine's retry backoff
      //    (`onInterrupted`), or by a NESTED child engine's poll, which reaches
      //    the parent through `NestedStackProvider` (go-to-k/cdkd#3875).
      //
      // The last shape is keyed on this engine's own `interruptCause`, not on
      // the class: `InterruptedError` does not carry its cause, and a child's
      // `'sibling-failure'` one must still roll back. The SIGINT handler sets
      // `'user'` before any poll or backoff can observe the signal, and a row
      // failure's `??= 'sibling-failure'` never overwrites it.
      if (
        error instanceof InterruptedError ||
        isInterruptedWaitError(error) ||
        this.interruptCause === 'user'
      ) {
        await this.writeRollbackJournalSegment(
          stackName,
          completedOperations,
          failedOperations,
          'interrupted',
          initialDeploy
        );
        this.logger.info(
          `Partial state saved (${Object.keys(newResources).length} resources). ` +
            "Run deploy again to resume, 'cdkd rollback' to revert, or destroy to clean up."
        );
        throw error;
      }

      // Deployment failed — attempt rollback unless --no-rollback is set
      if (this.options.noRollback) {
        // Record a journal segment so `cdkd rollback` can revert the failed
        // deploy later instead of only fixing forward / destroying.
        await this.writeRollbackJournalSegment(
          stackName,
          completedOperations,
          failedOperations,
          'no-rollback-failure',
          initialDeploy
        );
        this.logger.warn('Deployment failed. --no-rollback is set, skipping rollback.');
        this.logger.warn(
          safeMsg`Partial state has been saved. ${this.recoveryHint(
            "Run 'cdkd deploy' to resume, 'cdkd rollback' to revert, or destroy to clean up."
          )}`
        );
      } else {
        // Automatic in-process rollback. Write a journal segment FIRST so a
        // rollback that dies partway (crash / network / per-op failure)
        // leaves the segment behind and becomes resumable via `cdkd
        // rollback`; the segment is deleted after a clean replay + save.
        await this.writeRollbackJournalSegment(
          stackName,
          completedOperations,
          failedOperations,
          'auto-rollback-started',
          initialDeploy
        );
        const rollbackResult = await this.performRollback(
          completedOperations,
          newResources,
          stackName,
          currentState
        );
        autoRollbackClean = rollbackResult.failures === 0;
        // Hoisted out of this block because both saves below sit outside it
        // (issue #2934) — the post-rollback save and its ETag-mismatch retry —
        // and neither can see `rollbackResult`.
        rollbackOrphans = rollbackResult.orphaned;
        rollbackSettledNested = rollbackResult.settledNested;
      }

      // Save state after rollback (reflects rolled-back resource state).
      // This is critical: if rollback deleted resources, the state must reflect
      // that. Otherwise, next deploy will think deleted resources still exist.
      try {
        const postRollbackState: StackState = {
          version: STATE_SCHEMA_VERSION_CURRENT,
          region: this.stackRegion,
          stackName: currentState.stackName,
          resources: newResources,
          outputs: currentState.outputs,
          ...exportNamesCarriedFrom(currentState),
          ...skippedOutputsCarriedFrom(currentState),
          ...orphansAfterRollback(currentState, rollbackOrphans),
          // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
          // session resolved. See `crossStackReadsForPartialSave` — writing the
          // snapshot alone left a failed deploy's persisted record denying a
          // cross-stack read its own resources were built from.
          ...crossStackReadsForPartialSave(
            currentState,
            this.recordedImports,
            this.recordedOutputReads,
            this.crossStackReadKeyNormalizer()
          ),
          lastModified: Date.now(),
        };
        await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(postRollbackState),
          {
            ...(currentEtag !== undefined && { expectedEtag: currentEtag }),
          }
        );
        this.logger.debug('State saved after deployment failure');
        // Auto-rollback replayed cleanly AND the post-rollback state save
        // succeeded — the pre-deploy baseline is restored, so settle the
        // journal (issue #1183): drop it entirely, or — when the segment
        // carries failed in-flight op(s) — keep a failed-only segment so
        // `cdkd rollback --revert-failed` still works (issue #1208). A
        // partial / failed rollback keeps the full segment so `cdkd
        // rollback` can resume.
        if (autoRollbackClean) {
          await this.settleNestedChildrenAfterCleanRollback(
            stackName,
            rollbackSettledNested,
            await this.settleJournalAfterCleanRollback(stackName, failedOperations, initialDeploy)
          );
        }
      } catch (saveError) {
        // ETag mismatch from per-resource saves — force overwrite with fresh ETag
        this.logger.debug(
          `Retrying state save after rollback (ETag mismatch): ${saveError instanceof Error ? saveError.message : String(saveError)}`
        );
        try {
          const freshState = await this.stateBackend.getState(stackName, this.stackRegion);
          const freshEtag = freshState?.etag;
          const postRollbackState: StackState = {
            version: STATE_SCHEMA_VERSION_CURRENT,
            region: this.stackRegion,
            stackName: currentState.stackName,
            resources: newResources,
            outputs: currentState.outputs,
            ...exportNamesCarriedFrom(currentState),
            ...skippedOutputsCarriedFrom(currentState),
            ...orphansAfterRollback(currentState, rollbackOrphans),
            // Issue #2057: the UNION of the pre-deploy snapshot and what THIS
            // session resolved. See `crossStackReadsForPartialSave` — writing the
            // snapshot alone left a failed deploy's persisted record denying a
            // cross-stack read its own resources were built from.
            ...crossStackReadsForPartialSave(
              currentState,
              this.recordedImports,
              this.recordedOutputReads,
              this.crossStackReadKeyNormalizer()
            ),
            lastModified: Date.now(),
          };
          await this.stateBackend.saveState(
            stackName,
            this.stackRegion,
            this.withParentInfo(postRollbackState),
            {
              ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
            }
          );
          this.logger.debug('State saved after deployment failure (retry succeeded)');
          if (autoRollbackClean) {
            await this.settleNestedChildrenAfterCleanRollback(
              stackName,
              rollbackSettledNested,
              await this.settleJournalAfterCleanRollback(stackName, failedOperations, initialDeploy)
            );
          }
        } catch (retryError) {
          this.logger.warn(
            `Failed to save state after rollback: ${retryError instanceof Error ? retryError.message : String(retryError)}`
          );
        }
      }

      throw error;
    }

    // Resolve outputs. Under --strict-getatt an unresolvable Output makes
    // resolveOutputs THROW (instead of warn-and-skip). By this point EVERY
    // resource operation already succeeded in AWS, and the throw would
    // propagate through doDeploy's catch-less try — skipping the final
    // saveState. On a FIRST deploy `currentEtag` is undefined so the
    // incremental per-resource saves were no-ops too: rethrowing without a
    // save would leave every created resource invisible to cdkd (no state,
    // no rollback; a re-run collides with "already exists"). Persist the
    // provisioning result FIRST, then rethrow so the deploy still fails
    // (review blocker on issue #1111 item 2).
    let outputs: Record<string, unknown>;
    try {
      // ONE drain budget for the whole pass, not one per output (issue
      // #2563). `resolveOutputs` walks `template.Outputs` sequentially and
      // calls `resolve` per output, so without this the DRAIN GRACE spendable
      // here -- after every resource exists in AWS, before `saveState`, with
      // the S3 lock held -- was `#outputs x` the cap rather than the cap, and
      // CloudFormation allows 200 outputs. It bounds the GRACE, not the pass:
      // the cap arms on a rejection, so a lookup that hangs without one is as
      // unbounded here as it ever was. The trade the wrap makes is on
      // `withSharedDrainBudget`.
      outputs = await withSharedDrainBudget(() =>
        this.resolveOutputs(
          template,
          newResources,
          stackName,
          outputsDigestSource,
          parameterValues,
          conditions
        )
      );
      // Redact resolved secrets out of outputs before they flow to the exports
      // index / deploy summary / state (GHSA fix). The state save
      // (`withParentInfo`), the exports-index `updateForStack` and
      // `buildDisplayOutputs` each redact this bag again when they read it
      // (issue #2814). `redactOutputs` folds the outputs pass map into
      // `this.outputSecrets` — the outputs' own substituted references — and
      // `resolveOutputs` filled `this.outputsTemplateSource` with the
      // unresolved values that position
      // them (#1910).
      const resolvedOutputsBeforeRedaction = outputs;
      outputs = this.redactOutputs(outputs);
      // Issue #2274: remember, FOR THIS PROCESS ONLY, the plaintext behind any
      // output the redaction just replaced with the mask. Every cross-stack
      // route — a nested stack's `Outputs.<Key>`, `Fn::ImportValue`,
      // `Fn::GetStackOutput` — reads the producer's PERSISTED outputs, so
      // without this the first deploy of a consumer whose producer exports a
      // `NoEcho` custom-resource value would land on `***` and be refused: a
      // template that deployed before this feature. See
      // `recoverableMaskedOutputs` for why the key is a COORDINATE and not a
      // bare plaintext.
      // ONE call site, and it is here: an output that a LATER `redactOutputs`
      // newly masks — one folding in a needle a part recorded after this
      // point (issue #2814) — never enters the recoverable store. An
      // in-process cross-stack consumer of that output is then refused on
      // `***` instead of being served the plaintext, which is the fail-safe
      // direction and the reason this is stated rather than fixed.
      this.rememberRecoverableMaskedOutputs(stackName, resolvedOutputsBeforeRedaction, outputs);
    } catch (outputError) {
      await this.persistStateAfterOutputFailure(
        stackName,
        currentState,
        newResources,
        currentEtag,
        pendingMigration
      );
      // Every resource op succeeded here — provisioning was clean, only
      // output resolution failed — so rolling back is a legitimate use case
      // (issue #1183). Record a journal segment so `cdkd rollback` can revert.
      await this.writeRollbackJournalSegment(
        stackName,
        completedOperations,
        failedOperations,
        'no-rollback-failure',
        currentEtag === undefined
      );
      throw outputError;
    }

    return {
      state: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        region: this.stackRegion,
        stackName: currentState.stackName,
        resources: newResources,
        ...orphansCarriedFrom(currentState),
        outputs,
        // Always written, `[]` included: on this path the bag was re-resolved,
        // so the set is KNOWN (issue #2193). Absent would read as "not known".
        exportNames: [...this.resolvedExportNames],
        // This pass's skipped set, omitted when empty (issue #2740). Copied,
        // like the `exportNames` / `imports` spreads beside it.
        ...(this.skippedOutputs && { skippedOutputs: { ...this.skippedOutputs } }),
        ...(this.recordedImports.length > 0 && { imports: [...this.recordedImports] }),
        ...(this.recordedOutputReads.length > 0 && {
          outputReads: [...this.recordedOutputReads],
        }),
        lastModified: Date.now(),
      },
      actualCounts,
      completedOperations,
    };
  }

  /**
   * Persist state after provisioning fully succeeded but output resolution
   * threw (only reachable under `--strict-getatt`, whose promotion fires
   * AFTER the rollback catch block). The persisted shape mirrors the
   * success-path state EXCEPT for outputs:
   *
   * - `resources`: this run's provisioning result (`newResources`) — every
   *   create/update/delete landed in AWS, so state must record it.
   * - `imports` / `outputReads`: this run's `recordedImports` /
   *   `recordedOutputReads` (the provisioning that produced them succeeded;
   *   dropping them would desync the strong-reference records from AWS —
   *   matters on the update-deploy path where the pre-deploy snapshot may
   *   be stale).
   * - `outputs`: the PREVIOUSLY persisted map — resolveOutputs threw before
   *   producing a new one, mirroring what a resource-failure persist keeps.
   *   The exports index is deliberately NOT updated (it stays consistent
   *   with the old outputs that remain in state).
   *
   * ETag handling mirrors the post-rollback save: expected-ETag first (or
   * unconditional when `pendingMigration` — same as the per-resource save),
   * then a fresh-ETag retry, then warn. Best-effort: the deploy error being
   * rethrown is the primary signal; a failed save only warns.
   */
  private async persistStateAfterOutputFailure(
    stackName: string,
    currentState: StackState,
    newResources: Record<string, ResourceState>,
    currentEtag: string | undefined,
    pendingMigration: boolean
  ): Promise<void> {
    const buildState = (): StackState => ({
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: this.stackRegion,
      stackName: currentState.stackName,
      resources: newResources,
      outputs: currentState.outputs,
      ...exportNamesCarriedFrom(currentState),
      ...skippedOutputsCarriedFrom(currentState),
      ...orphansCarriedFrom(currentState),
      // Issue #2057: the UNION, like every other non-success save. This one
      // used to write `[...this.recordedImports]` WHOLESALE, copying the
      // SUCCESS path's shape onto a path that is not one — provisioning
      // succeeded, but output resolution threw, and the caller writes a
      // rollback journal segment and rethrows, so `cdkd rollback` reads
      // exactly this record. A deploy that no longer re-resolves a
      // cross-stack read (the reference moved, or the resource holding it had
      // no diff this run) therefore came through here with an EMPTY
      // `recordedOutputReads`, the field was omitted, and the producer region
      // the previous record carried was erased from under a
      // `properties.Value` that still holds the producer's region-less
      // spelling. `producerRegionsFromState` then returned `[]` and the replay
      // resolved it locally.
      ...crossStackReadsForPartialSave(
        currentState,
        this.recordedImports,
        this.recordedOutputReads,
        this.crossStackReadKeyNormalizer()
      ),
      lastModified: Date.now(),
    });
    try {
      const expectedEtag = pendingMigration ? undefined : currentEtag;
      await this.stateBackend.saveState(
        stackName,
        this.stackRegion,
        this.withParentInfo(buildState()),
        {
          ...(expectedEtag !== undefined && { expectedEtag }),
          migrateLegacy: pendingMigration,
        }
      );
      this.logger.debug('State saved after output resolution failure');
    } catch (saveError) {
      this.logger.debug(
        `Retrying state save after output resolution failure (ETag mismatch): ${saveError instanceof Error ? saveError.message : String(saveError)}`
      );
      try {
        const freshState = await this.stateBackend.getState(stackName, this.stackRegion);
        const freshEtag = freshState?.etag;
        await this.stateBackend.saveState(
          stackName,
          this.stackRegion,
          this.withParentInfo(buildState()),
          {
            ...(freshEtag !== undefined && { expectedEtag: freshEtag }),
          }
        );
        this.logger.debug('State saved after output resolution failure (retry succeeded)');
      } catch (retryError) {
        this.logger.warn(
          `Failed to save state after output resolution failure: ${retryError instanceof Error ? retryError.message : String(retryError)} — resources were provisioned but not recorded; run deploy again to reconcile.`
        );
      }
    }
  }

  /**
   * Provision a single resource (CREATE/UPDATE/DELETE)
   */
  private async provisionResource(
    logicalId: string,
    change: ResourceChange,
    stateResources: Record<string, ResourceState>,
    stackName: string,
    template?: CloudFormationTemplate,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>,
    counts?: ProvisionCounts,
    progress?: { current: number; total: number }
  ): Promise<ResourceOutcomeSignal | void> {
    const resourceType = change.resourceType;

    const renderer = getLiveRenderer();
    // The SAME question the dispatch asks (`propertyDrivenReplacement ||
    // recreateFlagged`), computed once and used by BOTH the verb and the
    // routing tag. Splitting it is what produced three rounds of one class:
    // the tag was fixed to include the flag half while the verb kept the
    // property half alone, so a `--recreate-via-*` target whose property change
    // does not itself force a replacement still rendered `Updating` over a
    // destroy + recreate.
    const labelRecreateDirection = this.recreateDirectionFor(stackName, logicalId);
    // The Type-change half (issue #3036) is mirrored too: the dispatch treats a
    // recorded type that differs from the template's as a replacement whatever
    // `propertyChanges` says.
    const labelRecordedType = stateResources[logicalId]?.resourceType;
    //
    // A CEILING (go-to-k/cdkd#3662) does not count here: whether it stands is
    // decided only once the UPDATE arm resolves the value, and a label saying
    // `Replacing` over an in-place update narrates something that does not
    // happen. The UPDATE arm re-labels the resource when the ceiling stands.
    const needsReplacement =
      (change.changeType === 'UPDATE' &&
        ((change.propertyChanges?.some(
          (pc) => pc.requiresReplacement && !isReplacementCeiling(pc)
        ) ??
          false) ||
          (labelRecordedType !== undefined && labelRecordedType !== resourceType))) ||
      labelRecreateDirection !== undefined;
    const verb =
      change.changeType === 'CREATE'
        ? 'Creating'
        : change.changeType === 'DELETE'
          ? 'Deleting'
          : needsReplacement
            ? 'Replacing'
            : 'Updating';
    // #614 §9 live-progress annotation: distinguish CC-routed work from
    // SDK-routed work so the user sees WHY a particular resource is taking
    // longer than its sibling (CC API is async-polling). CREATE / UPDATE
    // consult `getProviderFor` with the template-side properties +
    // recorded `provisionedBy` (the latter so sticky-CC resources keep
    // the tag even when the update payload has no silent-drop property
    // of its own — design §8). DELETE short-circuits on recorded
    // `provisionedBy` since delete routing is fully driven by state, not
    // by the template. Routing is based on top-level property NAMES
    // which intrinsic resolution does not change, so the pre-routing
    // here matches the real decision in `provisionResourceBody`. Errors
    // here never surface — if routing inference fails, we drop the tag
    // and the real `getProviderFor` call later will re-evaluate.
    const labelRouting = this.peekRoutingForLabel(
      change,
      stateResources[logicalId],
      stackName,
      logicalId,
      needsReplacement,
      labelRecreateDirection
    );
    const routingTag = labelRouting === 'cc-api' ? ' [CC API]' : '';
    const baseLabel = `${verb} ${logicalId} (${resourceType})${routingTag}`;
    renderer.addTask(logicalId, baseLabel);
    this.liveTaskLabels.set(logicalId, { label: baseLabel, replacing: needsReplacement });

    // Operation classification for the timeout error message. UPDATE and
    // its replacement-replacement form are both surfaced as 'UPDATE' since
    // the user-facing distinction (which immutable property triggered it)
    // is already in the renderer label.
    const operationKind: 'CREATE' | 'UPDATE' | 'DELETE' =
      change.changeType === 'CREATE'
        ? 'CREATE'
        : change.changeType === 'DELETE'
          ? 'DELETE'
          : 'UPDATE';

    // Per-resource-type overrides (v2) win over the global default.
    // Resolution order at the call site:
    //   1. per-type CLI override map for this resourceType — explicit
    //      escape hatch, always wins (`--resource-timeout TYPE=DURATION`).
    //   2. provider self-report (`getMinResourceTimeoutMs()`) raised
    //      against the global default — long-running providers
    //      (Custom Resource polls up to 1h) lift the deadline for their
    //      resources without forcing every user to remember
    //      `--resource-timeout 1h`.
    //   3. CLI global default (`--resource-timeout 30m`).
    //   4. compile-time default (DEFAULT_RESOURCE_*_MS).
    //
    // `getProvider` here only consults the resource type (no template
    // properties / no state-recorded layer) — it's used solely to read
    // `getMinResourceTimeoutMs`. The real routing decision (which can
    // promote a Tier 1 resource to Cloud Control under #614) happens
    // inside `provisionResourceBody` via `getProviderFor`.
    const provider = this.providerRegistry.getProvider(resourceType);
    const providerMinTimeoutMs = provider.getMinResourceTimeoutMs?.() ?? 0;
    const warnAfterMs =
      this.options.resourceWarnAfterByType?.[resourceType] ??
      this.options.resourceWarnAfterMs ??
      DEFAULT_RESOURCE_WARN_AFTER_MS;
    const globalTimeoutMs = this.options.resourceTimeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS;
    // Known-slow types (OpenSearch domains, RDS / Redshift / ElastiCache
    // clusters) lift the outer deadline to match the CC inner poll cap so a
    // slow CREATE / UPDATE is not aborted by the 30-min default. A per-type CLI
    // override still wins (explicit escape hatch).
    const slowTypeMinTimeoutMs = slowCcOperationTimeoutMs(resourceType, operationKind);
    const timeoutMs =
      this.options.resourceTimeoutByType?.[resourceType] ??
      Math.max(providerMinTimeoutMs, slowTypeMinTimeoutMs, globalTimeoutMs);

    // #808 best-effort event: per-resource op started. `provisionedBy`
    // is the routing inference used for the live label (same decision the
    // real provider call makes); good enough for the event metadata.
    const eventOp: DeploymentResourceOperation = operationKind;
    const resourceStartedAt = Date.now();
    this.recordEvent({
      eventType: 'RESOURCE_STARTED',
      stackName,
      operation: eventOp,
      logicalId,
      resourceType,
      ...(labelRouting && { provisionedBy: labelRouting }),
    });

    // Issue #1762: set when the body's DELETE branch consumed a
    // `{ outcome: 'skipped' }` from the provider. Assigned inside the
    // deadline callback (same shape destroy-runner.ts uses for its own
    // `deleteResult`) because the body's return value is otherwise swallowed
    // by `withResourceDeadline`.
    let deleteSkipped: string | undefined;
    // Issue #1819: an UPDATE that left a resource behind. Unlike
    // `deleteSkipped` this does NOT suppress `RESOURCE_SUCCEEDED` — the row's
    // resource really was updated — it adds a second event naming the survivor.
    let updatePartial: string | undefined;
    // Snapshot BEFORE the body runs: a replacement re-points the state record
    // to the NEW physical id, so by the time the event is built the survivor's
    // id is gone from state and only the free-text reason would still carry it.
    const physicalIdBeforeUpdate = stateResources[logicalId]?.physicalId;
    const provisionedByBeforeUpdate = stateResources[logicalId]?.provisionedBy;
    try {
      await withResourceDeadline(
        async () => {
          const bodyResult = await this.provisionResourceBody(
            logicalId,
            change,
            stateResources,
            stackName,
            template,
            parameterValues,
            conditions,
            counts,
            progress
          );
          deleteSkipped = bodyResult?.deleteSkipped;
          updatePartial = bodyResult?.updatePartial;
        },
        {
          warnAfterMs,
          timeoutMs,
          onWarn: (elapsedMs) => {
            const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
            const warnSuffix = ` [taking longer than expected, ${minutes}m+]`;
            // Mutate the live renderer's task label in place (TTY mode)
            // and emit a warn line above the live area (non-TTY / verbose).
            const current = this.liveTaskLabels.get(logicalId);
            if (current !== undefined) current.warnSuffix = warnSuffix;
            renderer.updateTaskLabel(logicalId, `${current?.label ?? baseLabel}${warnSuffix}`);
            renderer.printAbove(() => {
              this.logger.warn(
                `${logicalId} (${resourceType}) has been ${operationKind === 'CREATE' ? 'creating' : operationKind === 'DELETE' ? 'deleting' : 'updating'} for ${minutes}m — still waiting`
              );
            });
          },
          onTimeout: (elapsedMs) =>
            new ResourceTimeoutError(
              logicalId,
              resourceType,
              this.stackRegion,
              elapsedMs,
              operationKind,
              timeoutMs
            ),
        }
      );
      // Issue #1762: a DELETE the provider refused to issue is NOT a
      // success — the events store is the durable post-mortem, and
      // `RESOURCE_SUCCEEDED` there would claim cdkd deleted a resource that
      // is still alive. Mirrors destroy-runner.ts's RESOURCE_SKIPPED emit,
      // `reason` included: a bare event cannot tell the user why.
      if (deleteSkipped !== undefined) {
        this.recordEvent({
          eventType: 'RESOURCE_SKIPPED',
          stackName,
          operation: eventOp,
          logicalId,
          resourceType,
          ...(stateResources[logicalId]?.provisionedBy
            ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
            : labelRouting && { provisionedBy: labelRouting }),
          ...(stateResources[logicalId]?.physicalId && {
            physicalId: stateResources[logicalId]?.physicalId,
          }),
          reason: deleteSkipped,
          durationMs: Date.now() - resourceStartedAt,
        });
        return { deleteSkipped };
      }
      // Issue #1819 / #1922: the row's resource WAS updated, so it still gets
      // `RESOURCE_SUCCEEDED` below. What did NOT happen is the retirement of
      // the resource the update owned, so that gets its own `RESOURCE_SKIPPED`
      // — whose documented invariant ("the resource this row names was not
      // destroyed") is exactly true of the survivor, and false of the updated
      // row. Emitting only the skip, as the issue first proposed, would have
      // put the events store at odds with its own contract.
      if (updatePartial !== undefined) {
        this.recordEvent({
          eventType: 'RESOURCE_SKIPPED',
          stackName,
          operation: eventOp,
          logicalId,
          resourceType,
          // The SURVIVOR's routing layer, snapshotted with its id below: the
          // post-update record describes the NEW resource, so a replacement
          // that re-routed would label the survivor with the wrong layer.
          ...(provisionedByBeforeUpdate
            ? { provisionedBy: provisionedByBeforeUpdate }
            : labelRouting && { provisionedBy: labelRouting }),
          // The SURVIVOR's id as a FIELD, not only inside `reason`: a `--json`
          // consumer should not have to parse prose, and this is the one datum
          // a cleanup pass actually needs.
          ...(physicalIdBeforeUpdate && { physicalId: physicalIdBeforeUpdate }),
          reason: updatePartial,
          durationMs: Date.now() - resourceStartedAt,
        });
      }
      // #808 best-effort event: per-resource op succeeded. Read the
      // freshly-stamped routing layer + physical id off the state record
      // the body just wrote (falls back to the label inference / undefined).
      this.recordEvent({
        eventType: 'RESOURCE_SUCCEEDED',
        stackName,
        operation: eventOp,
        logicalId,
        resourceType,
        ...(stateResources[logicalId]?.provisionedBy
          ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
          : labelRouting && { provisionedBy: labelRouting }),
        ...(stateResources[logicalId]?.physicalId && {
          physicalId: stateResources[logicalId]?.physicalId,
        }),
        durationMs: Date.now() - resourceStartedAt,
      });
    } catch (error) {
      renderer.removeTask(logicalId);
      const message = error instanceof Error ? error.message : String(error);
      // Issue #2038: MASKED, and at a strictly higher log level than the retry
      // give-up summary one statement below it. `perResourceSecrets` is
      // populated right after `resolver.resolve` and BEFORE the provider call
      // on both the CREATE and the UPDATE path, so whenever this resource
      // resolved a `{{resolve:...}}` reference the bag handed to the provider
      // was PLAINTEXT — and an AWS validation error routinely quotes the
      // offending value back (`Value '<secret>' at 'clientSecret' failed to
      // satisfy constraint ...`). The `recordEvent` below already masked (via
      // `maskSecretsInEvent`); this `error` line did not, so the durable sink
      // was clean while the terminal printed the secret at DEFAULT verbosity.
      // Masks the CONCATENATED line, matching `maskingRetryLogger`; forwards
      // verbatim for a resource with no recorded secret.
      this.logger.error(
        this.maskForResource(
          logicalId,
          `Failed to ${change.changeType.toLowerCase()} ${logicalId}: ${message}`
        )
      );

      // Issue #2901's sibling, #2902: a plain CREATE colliding with a name
      // cdkd itself derived. Emitted as its own line so the AWS sentence above
      // stays verbatim, and masked like it — the id is template-derived, so a
      // stack or logical id built from a resolved secret would otherwise reach
      // a DEFAULT-level line the one above is masked for.
      const orphanAdvice = this.orphanedNameCollisionAdvice(change.changeType, logicalId, error);
      if (orphanAdvice) {
        this.logger.error(this.maskForResource(logicalId, orphanAdvice));
      }

      // #808 best-effort event: per-resource op failed. Error metadata
      // only — no resource properties.
      this.recordEvent({
        eventType: 'RESOURCE_FAILED',
        stackName,
        operation: eventOp,
        logicalId,
        resourceType,
        ...(stateResources[logicalId]?.provisionedBy
          ? { provisionedBy: stateResources[logicalId]?.provisionedBy }
          : labelRouting && { provisionedBy: labelRouting }),
        durationMs: Date.now() - resourceStartedAt,
        error: extractDeploymentEventError(error),
      });

      // Issue #2038 review: the CAUSE is masked too, and that is a THIRD sink
      // rather than a belt-and-braces repeat of the two above. `formatError`
      // renders a `CdkdError`'s cause as `Caused by: <cause.message>` and
      // `handleError` logs it at `error` level, so a deploy that fails on a
      // secret-bearing resource printed the plaintext at the CLI boundary even
      // with both log sites masked — the sink reads the error OBJECT, not the
      // text this method formatted. `maskSecretsInError` clones with every own
      // property descriptor (symbols included), so `markNonRetryable`'s marker,
      // `$metadata` and any nested `cause` survive for the classifiers, and it
      // returns the original by identity when nothing matched. Deliberately
      // AFTER `extractDeploymentEventError` above, which masks separately via
      // `recordEvent` and would otherwise mask twice for no benefit.
      throw new ProvisioningError(
        `Failed to ${change.changeType.toLowerCase()} resource ${logicalId}`,
        resourceType,
        logicalId,
        stateResources[logicalId]?.physicalId,
        error instanceof Error
          ? maskSecretsInError(error, this.perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS)
          : undefined
      );
    } finally {
      // Safety net for early-break paths (UPDATE skip, DeletionPolicy: Retain).
      // removeTask is idempotent, so calling it again after the explicit calls
      // above is a no-op.
      renderer.removeTask(logicalId);
    }
  }

  /**
   * Is this resource pinned to Cloud Control for this deploy (`--pin-cc-api`)?
   *
   * ONE implementation, called by the update dispatch and by the progress
   * label. They carried separate copies of this expression for one revision,
   * and a mutation probe caught the predictable result: neutering the LABEL's
   * copy left every test green, because the only cases that existed exercised
   * the dispatch's. Same shape as the duplicated flip predicate this lane
   * already collapsed once.
   *
   * SCOPED BY STACK, like `recreateTargets`. `NestedStackProvider.runChildDeploy`
   * spreads the parent's options into every child engine, and a logical id is
   * unique only within one template, so an unscoped set would pin a same-named
   * resource in a stack the user never named — silently, since a pin produces
   * no output of its own.
   */
  private isPinnedToCcApi(stackName: string, logicalId: string): boolean {
    return (
      this.options.pinCcApi?.stackName === stackName &&
      this.options.pinCcApi.logicalIds.has(logicalId)
    );
  }

  /**
   * The `--recreate-via-*` direction for this resource, or `undefined`.
   *
   * Stack-scoped for the same reason as {@link isPinnedToCcApi}, and extracted
   * for a sharper one: the LABEL and the DISPATCH were computing "is this a
   * replacement" from DIFFERENT expressions. The dispatch asks
   * `propertyDrivenReplacement || recreateFlagged`; the label asked only the
   * property half. So a `--recreate-via-*` target whose property change does
   * not itself force a replacement took the label's non-replacement path and
   * was routed from the state record, while the dispatch routed it from the
   * flag -- mislabelling in BOTH directions, and rendering `Updating` over a
   * destroy + recreate.
   *
   * Three review rounds fixed three instances of that one class (the pin, then
   * the sticky inputs, then this) by subtracting one input at a time from the
   * label. The class closes by asking the same QUESTION at both sites instead.
   */
  private recreateDirectionFor(stackName: string, logicalId: string): 'sdk' | 'cc-api' | undefined {
    const targets =
      this.options.recreateTargets?.stackName === stackName
        ? this.options.recreateTargets
        : undefined;
    if (targets === undefined) return undefined;
    if (targets.viaCcApi.has(logicalId)) return 'cc-api';
    if (targets.viaSdkProvider.has(logicalId)) return 'sdk';
    return undefined;
  }

  private peekRoutingForLabel(
    change: ResourceChange,
    existingState: ResourceState | undefined,
    stackName: string,
    logicalId: string,
    needsReplacement = false,
    recreateDirection?: 'sdk' | 'cc-api'
  ): 'sdk' | 'cc-api' | undefined {
    // The pin is resolved HERE rather than inside `deriveLabelRouting` because
    // that function is exported and unit-tested without an engine; keeping it
    // free of `this.options` is what lets it be called with a plain registry.
    // `needsReplacement` already folds in the flag half -- the caller computes
    // it once so the VERB and this tag cannot disagree, which is the whole
    // lesson of {@link recreateDirectionFor}'s docstring.
    if (needsReplacement) {
      // Mirror `replaceDecision` argument for argument: it routes the NEW
      // physical resource, so it passes the recreate hint as `provisionedBy`
      // (never the record's layer — stickiness exists to spare an EXISTING
      // resource from churn, and a replacement is not that), `forceCcApi` only
      // for the CC direction, and the record's bag as `previousProperties` —
      // the baseline an unrecognized property is compared against (issue
      // #3713). `deriveLabelRouting` derives both from this synthetic record,
      // so it carries the hint and the record's `properties`, nothing else.
      const hintRecord = {
        ...(recreateDirection !== undefined && { provisionedBy: recreateDirection }),
        ...(existingState?.properties !== undefined && { properties: existingState.properties }),
      };
      return deriveLabelRouting(
        change,
        hintRecord,
        this.providerRegistry,
        recreateDirection === 'cc-api'
      );
    }
    return deriveLabelRouting(
      change,
      existingState,
      this.providerRegistry,
      this.isPinnedToCcApi(stackName, logicalId)
    );
  }

  /**
   * #808 — forward one structured deployment event to the optional
   * recorder. No-op when no recorder was supplied. `record()` is
   * contractually synchronous and never-throwing, but we still guard
   * with a try/catch so an event emission can NEVER abort a deploy.
   */
  /** @internal */
  recordEvent(
    event: Omit<import('../types/deployment-events.js').DeploymentEvent, 'timestamp'>
  ): void {
    if (!this.options.eventRecorder) return;
    try {
      this.options.eventRecorder.record(this.maskSecretsInEvent(event));
    } catch {
      // best-effort: never let event recording surface into the deploy path
    }
  }

  /**
   * Mask any resolved secret value out of an event's human-authored text before
   * it is persisted to `deployments/*.jsonl` (which outlives `cdkd destroy`)
   * — GHSA fix. An AWS validation error can quote the offending property value
   * (`Value '<secret>' at 'X' failed to satisfy ...`), and a provider `reason`
   * is provider-authored prose; both reach the event store as `error.message` /
   * `reason`. No-op when the deploy recorded no secrets.
   *
   * The LOG-ONLY needles count (go-to-k/cdkd#1998): a `NoEcho` parameter's
   * value quoted inside an AWS error is exactly what this store must not keep,
   * and masking text in an event rewrites no value cdkd reads back.
   */
  private maskSecretsInEvent<
    T extends { logicalId?: string; error?: { message?: string }; reason?: string },
  >(event: T): T {
    // Mask with the event's own resource secrets; a resource-less (run-level)
    // event carries no properties-derived text.
    const secrets = event.logicalId ? this.perResourceSecrets.get(event.logicalId) : undefined;
    if (!secrets || !hasMaskableValues(secrets)) return event;
    const next: T = { ...event };
    if (next.error?.message) {
      next.error = { ...next.error, message: maskSecretsInText(next.error.message, secrets) };
    }
    if (next.reason) next.reason = maskSecretsInText(next.reason, secrets);
    return next;
  }

  /**
   * Issue #1002 PR 2 — §7 step 3 post-resolution audit (defense in depth).
   * No-op in legacy mode (`options.assetRedirect` unset). In cdkd-assets
   * mode, a resolved property still naming a mapped SOURCE (CDK bootstrap)
   * bucket / repo means a template shape the §7 rewrite missed — fail the
   * resource loudly BEFORE provisioning instead of deploying a split-brain
   * reference (assets live in cdkd storage, the property points at the CDK
   * bootstrap bucket that `cdk gc` may have emptied).
   */
  private auditResolvedAssetReferences(
    logicalId: string,
    resourceType: string,
    resolvedProps: Record<string, unknown>
  ): void {
    const redirect = this.options.assetRedirect;
    if (!redirect) return;
    const findings = findUnrewrittenAssetReferences(resolvedProps, redirect);
    if (findings.length === 0) return;
    const detail = findings.map((f) => `  - ${f.path}: still references '${f.source}'`).join('\n');
    throw new ProvisioningError(
      `Unrewritten asset reference on '${logicalId}' (${resourceType}): this region uses ` +
        `cdkd-owned asset storage, but the following resolved properties still point at the ` +
        `CDK bootstrap storage that 'cdk gc' may garbage-collect:\n${detail}\n` +
        `This is a template shape cdkd's asset-reference rewrite did not cover — deploying it ` +
        `would split-brain the stack (assets in cdkd storage, properties reading the CDK ` +
        `bucket). Please report this at https://github.com/go-to-k/cdkd/issues with the ` +
        `property shape. Workaround: deploy with --use-cdk-bootstrap-assets to pin the ` +
        `legacy destinations for this app.`,
      resourceType,
      logicalId
    );
  }

  /**
   * What a replacement's delete of the OLD resource tells the provider
   * (issue #4029): the governing `UpdateReplacePolicy`, and the
   * `--skip-final-snapshot` opt-out. `CloudControlProvider.delete` reads both
   * to keep an RDS cluster or instance off the registry handler, which would
   * otherwise take an untagged snapshot of its own.
   */
  private replacementDeleteContext(updateReplacePolicy: string | undefined): {
    deletionPolicy: string;
    skipFinalSnapshot?: true;
  } {
    return {
      deletionPolicy: replacementDeletePolicy(updateReplacePolicy),
      ...(this.options.skipFinalSnapshot === true && { skipFinalSnapshot: true as const }),
    };
  }

  /**
   * The `Snapshot`-policy gate every engine delete site runs BEFORE its
   * delete (issues #1352 / #1353 / #1354). Given the resource's effective
   * policy for THIS delete (`DeletionPolicy` on the destroy / removal paths,
   * `UpdateReplacePolicy` on the replacement paths):
   *
   *   - not `Snapshot` (or `--skip-final-snapshot`) → no-op.
   *   - atomic type, SDK-routed → returns the generated identifier for the
   *     provider's atomic final-snapshot delete parameter.
   *   - atomic type, cc-api-routed → refuses (Cloud Control has no
   *     final-snapshot parameter; `CloudControlProvider.delete` also
   *     fail-closes on the context field as defense-in-depth).
   *   - `PRE_DELETE_SNAPSHOT_TYPES` (EC2 Volume / Redshift Cluster /
   *     ElastiCache ReplicationGroup) → creates the snapshot and waits for
   *     it here, then returns undefined (the subsequent delete is plain).
   *   - anything else Snapshot-tagged → refuses.
   */
  private async prepareFinalSnapshotForDelete(
    logicalId: string,
    resourceType: string,
    currentResource: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' | undefined },
    policy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined
  ): Promise<string | undefined> {
    if (policy !== 'Snapshot' || this.options.skipFinalSnapshot === true) return undefined;
    if (
      ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) &&
      currentResource.provisionedBy !== 'cc-api'
    ) {
      return buildFinalSnapshotIdentifier(currentResource.physicalId, resourceType);
    }
    if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType)) {
      throw ccRoutedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
    }
    if (PRE_DELETE_SNAPSHOT_TYPES.has(resourceType)) {
      // Region-pinned clients: `getAwsClients()` is a process-global that a
      // concurrent stack's deploy can repoint at ANOTHER region
      // (`--stack-concurrency > 1` + multi-region apps); a wrong-region
      // snapshot call 404s as a NotFound, which would be read as "source
      // gone" and skip the snapshot. Prefer the engine-scoped clients
      // threaded via options.
      await createPreDeleteFinalSnapshot(
        resourceType,
        currentResource.physicalId,
        logicalId,
        this.options.finalSnapshotClients ?? getAwsClients(),
        this.logger
      );
      return undefined;
    }
    throw unsupportedFinalSnapshotError(logicalId, resourceType, '--skip-final-snapshot');
  }

  /**
   * `--replace` delete-first fallback for a property-driven replacement of a
   * custom-named resource: delete the old name holder, then re-create it
   * under the same name. Shared by the create-first collision catch (issue
   * #960 follow-up) and the name-idempotent same-id guard (issue #1238) so
   * the two --replace escape hatches cannot drift apart.
   */
  private async replaceDeleteFirstAndRecreate(
    logicalId: string,
    /** The TEMPLATE's type — what the re-create routes on. */
    resourceType: string,
    /**
     * The STATE RECORD's type — what the old resource's delete and final
     * snapshot route on (issue #2668). Equal to `resourceType` unless the
     * resource's `Type` changed.
     */
    oldResourceType: string,
    currentResource: ResourceState,
    oldDeleteProvider: ResourceProvider,
    replaceProvider: ResourceProvider,
    replaceProps: Record<string, unknown>,
    // Issue #1932 item 3. A PARAMETER rather than a field read inside the
    // method: this helper is shared by both --replace escape hatches, and both
    // call it from the UPDATE case where the resolution pass's own bag is in
    // scope. Reading `perResourceSecrets` here instead would work today but
    // would bind the masker to a map looked up by logical id rather than to
    // the bag the caller actually resolved with, which is a different (and
    // silently wrong under concurrency) thing.
    //
    // Issue #2038 review: it is the BAG, not the finished `CreateContext`, for
    // exactly that reason. The retry logger and the two wrap messages below
    // need the same bag the masker is built from, and re-deriving it from
    // `perResourceSecrets` inside this method would have made the file state
    // the rule above and then break it three lines on. The `CreateContext` is
    // built here from this argument, so the provider call is unchanged.
    secrets: RecordedSecretValues,
    updateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate'
  ): Promise<Awaited<ReturnType<ResourceProvider['create']>>> {
    const createContext: CreateContext = { maskSecrets: createSecretMasker(secrets) };
    // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the OLD
    // resource before the replacement delete, exactly like the destroy
    // paths honor `DeletionPolicy: Snapshot`. Deliberately OUTSIDE the
    // delete's try: a snapshot failure/refusal here must surface with its
    // own typed FINAL_SNAPSHOT_* error, not be rewrapped as "Failed to
    // delete old resource ..." for a delete that was never attempted.
    const finalSnapshotIdentifier = await this.prepareFinalSnapshotForDelete(
      logicalId,
      oldResourceType,
      currentResource,
      updateReplacePolicy
    );
    let deleteResult: void | ResourceDeleteResult;
    try {
      deleteResult = await oldDeleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        oldResourceType,
        currentResource.properties,
        {
          expectedRegion: this.stackRegion,
          // Replacement delete: `--force-stateful-recreation` is the user's
          // explicit data-loss consent, so thread it to the provider's data
          // guard (issue #1340).
          forceDataDelete: this.options.forceStatefulRecreation === true,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          ...this.replacementDeleteContext(updateReplacePolicy),
          recordedAttributes: currentResource.attributes,
        }
      );
    } catch (deleteError) {
      // Mirror the recreate-flagged path's wrapping: the delete is
      // load-bearing here (without it the re-create collides again).
      //
      // Issue #2038: masked at CONSTRUCTION, not only where it is logged. This
      // message lands in `provisionResource`'s `error` line, in the durable
      // `RESOURCE_FAILED` event, and in the `ProvisioningError` cause — all
      // three of which mask it again, so double-masking is a no-op. Masking
      // here means the plaintext never exists inside a thrown `Error` at all,
      // so a future reader of the `cause` chain cannot re-open the hole. The
      // delete's own payload is the STATE record, which is redacted; the wrap
      // is masked because a provider re-creating from `replaceProps` can echo
      // the resolved value back through this catch.
      //
      // MEASURED UNFENCEABLE, deliberately kept: removing this mask (and the
      // twin on the re-create wrap below) leaves the whole unit suite green,
      // because every reader downstream masks independently. It is
      // defense-in-depth against a future change to one of those readers, not
      // a fence — do not record it in a PR body as a tested behavior.
      throw new Error(
        maskSecretsInText(
          `Failed to delete old resource ${logicalId} (${currentResource.physicalId}) ` +
            `during the --replace delete-first fallback: ` +
            `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
          secrets
        )
      );
    }
    // Issue #1762: a skip here FAILS the resource, unlike the template-DELETE
    // branch. The old resource is still alive and the whole point of this
    // path is that the re-create needs its name released — proceeding would
    // either collide or, for a type with no name conflict, leave two live
    // resources with state describing one. Checked outside the catch above so
    // the wrapping never sees it (a return value, not a throw).
    const replaceSkipReason = deleteSkipReason(deleteResult);
    if (replaceSkipReason !== undefined) {
      throw new Error(
        deleteSkippedMessage(
          logicalId,
          currentResource.physicalId,
          replaceSkipReason,
          'during the --replace delete-first fallback'
        )
      );
    }
    this.logger.info(`  ${green('✓')} Old resource deleted`);
    this.logger.info(`  Re-creating ${logicalId}...`);
    try {
      // Some providers return from delete() before the name is
      // actually released (async deletes: Step Functions, Kinesis,
      // Pipes DELETING state). "already exists" is deliberately
      // NOT in the transient-retry patterns, so give the re-create
      // its own bounded collision retry instead of failing fast
      // with the old resource already gone. SQS additionally
      // enforces a ~60s same-name re-creation cooldown after the
      // delete (QueueDeletedRecently, issue #1206) — the schedule
      // (2s/4s/8s then capped at 10s over 8 retries ≈ 64s total
      // sleep) covers the full cooldown window even when the inner
      // generic retry's budget is exhausted first.
      return await withRetry(
        () =>
          this.withRetry(
            // Issue #1903, same scope as the ordinary CREATE path: bind the
            // resolved-secrets bag around every provider create, so no
            // replacement route can silently skip the nested-stack seed.
            () =>
              withCurrentResourceSecrets(secrets, () =>
                replaceProvider.create(logicalId, resourceType, replaceProps, createContext)
              ),
            logicalId,
            undefined,
            undefined,
            replaceProvider
          ),
        logicalId,
        {
          maxRetries: 8,
          initialDelayMs: 2_000,
          maxDelayMs: 10_000,
          // Issue #2038: `replaceProps` is RESOLVED, so mask the AWS message
          // this retry echoes. Bound to the CALLER's bag (the `secrets`
          // parameter above), not looked up by logical id -- see
          // {@link maskingRetryLoggerFor}.
          logger: this.maskingRetryLoggerFor(secrets),
          isInterrupted: () => this.interrupted,
          onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
          isRetryable: isRecreateRetryableError,
        }
      );
    } catch (recreateError) {
      // The old resource is ALREADY deleted at this point — say so,
      // because state still records it and the next deploy's UPDATE
      // would otherwise chase a resource that no longer exists.
      //
      // Issue #2038: masked at construction, same reason as the delete wrap
      // above — and more acutely, since THIS one wraps a create that was
      // handed the RESOLVED `replaceProps`.
      //
      // Issue #2616 swept this site alongside its twin in the
      // UPDATE-not-supported fallback, and the mask-asymmetry note on that
      // twin covers this site in substance: the `cause` is chained UNMASKED
      // because `provisionResource`'s catch masks the whole chain further up
      // the stack. NOT "one frame up" as the twin's note says — that wording
      // is exact only there; this throw sits in
      // `replaceDeleteFirstAndRecreate`, called from `provisionResourceBody`,
      // which `provisionResource` invokes through `withResourceDeadline`. The
      // `cause` is what keeps the AWS
      // rejection behind the sentence readable — `extractDeploymentEventError`
      // walks the chain for `$metadata` / `Code`, so an unchained wrap sends a
      // `RESOURCE_FAILED` event with no `awsErrorCode` at all. Nothing between
      // here and the DAG executor re-classifies the throw (the retry loop is
      // the `withRetry` above, already exhausted), so chaining cannot revive a
      // retry off the cause's text.
      throw new Error(
        maskSecretsInText(
          `Failed to re-create ${logicalId} after the --replace delete-first fallback ` +
            `already deleted the old resource (${currentResource.physicalId}): ` +
            `${recreateError instanceof Error ? recreateError.message : String(recreateError)}. ` +
            `Re-run the deploy to create it fresh.`,
          secrets
        ),
        { cause: recreateError instanceof Error ? recreateError : undefined }
      );
    }
  }

  /**
   * The name a Type-changed replacement asks for, as a change to probe
   * (go-to-k/cdkd#3937): across two types the "same" name is not one the old
   * resource holds in the new type's name space. `undefined` without an
   * explicit, plain name (a generated one is not compared).
   */
  private typeChangeNameQuestion(
    resourceType: string,
    input: { desiredProperties: Record<string, unknown>; currentResource: ResourceState }
  ): ReplacementNameChange | undefined {
    const property = explicitNamePropertyFor(resourceType);
    if (property === undefined) return undefined;
    const desired = input.desiredProperties[property];
    if (typeof desired !== 'string' || desired === '' || desired === SECRET_MASK) return undefined;
    if (desired.includes('{{resolve:')) return undefined;
    return {
      property,
      desiredName: desired,
      heldName: undefined,
      heldProperty: undefined,
      physicalId: input.currentResource.physicalId,
    };
  }

  /**
   * The name a replacement moves to when it is KNOWN to differ from the one
   * the old resource holds ({@link replacementRequestsDifferentName}), checked
   * against AWS where the create would not refuse a taken name
   * (go-to-k/cdkd#3937, {@link replacementNameProbe}).
   *
   * - The probe finds ANOTHER resource under the name: refuses, with nothing
   *   created or deleted — the create would hand that resource back (or
   *   overwrite it) and the deploy would record it as its own.
   * - It finds the OLD resource: the difference was not real, so `undefined`
   *   and the caller keeps its pre-existing order.
   * - It cannot be asked, or fails: refuses, since a guess either way can
   *   adopt a stranger's resource.
   *
   * The answer also picks the ORDER of the fallback and `--recreate-via-*`
   * arms, so it compares names exactly unless the type's name space is known
   * to fold case (go-to-k/cdkd#3931, {@link replacementOrderIsCaseSensitive});
   * an EventBridge rule moving bus counts as a name change
   * ({@link replacementMovesEventBus}). A Type change onto a name-adopting
   * type always asks, and a holder found under the id the old resource of
   * ANOTHER type has is still refused: two namespaces, two resources.
   */
  private async checkedReplacementNameChange(input: {
    logicalId: string;
    resourceType: string;
    oldResourceType: string;
    stackName: string;
    currentResource: ResourceState;
    desiredProperties: Record<string, unknown>;
    createProvider: ResourceProvider;
    createdVia: ProvisionedBy | undefined;
    createProps: Record<string, unknown>;
    secrets: RecordedSecretValues;
  }): Promise<ReplacementNameChange | undefined> {
    const { logicalId, resourceType, currentResource, secrets } = input;
    const question = {
      oldResourceType: input.oldResourceType,
      newResourceType: resourceType,
      desiredProperties: input.desiredProperties,
      recorded: currentResource.properties,
      observed: currentResource.observedProperties,
      physicalId: currentResource.physicalId,
    };
    // The #3808 comparison folds case, which is the safe direction for a
    // refusal. Here it decides whether deleting first frees the name, and
    // whether an adopting create is asked first, so a case-only rename is a
    // different name unless the type folds case.
    const adopts = replacementCreateAdoptsName(resourceType, input.createdVia);
    const typeChanged = input.oldResourceType !== resourceType;
    const change =
      replacementRequestsDifferentName(question) ??
      (adopts || replacementOrderIsCaseSensitive(resourceType)
        ? replacementRequestsDifferentName({ ...question, caseSensitive: true })
        : undefined) ??
      replacementMovesEventBus(question) ??
      (adopts && typeChanged ? this.typeChangeNameQuestion(resourceType, input) : undefined);
    if (change === undefined) return undefined;
    const probe = replacementNameProbe({
      resourceType,
      createdVia: input.createdVia,
      change,
      region: this.stackRegion,
    });
    if (probe === undefined) return change;
    const subject = `${displaySafe(logicalId)} (${displaySafe(resourceType)})`;
    const adoptsText =
      `its create API hands back or overwrites an existing resource of that name instead of ` +
      `refusing it`;
    if (probe === null) {
      throw markNonRetryable(
        new CdkdError(
          maskSecretsInText(
            `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd cannot ` +
              `check whether another resource already holds it. Nothing was created or deleted.`,
            secrets
          ),
          'NAMED_REPLACEMENT_COLLISION'
        )
      );
    }
    // Every SDK provider of a name-adopting type implements `import()`
    // (pinned in `replacement-name-holder.test.ts`). One without it is a test
    // double or a wrapper; refusing there would turn every mocked renamed
    // queue, topic, rule or alarm in the suite into a probe test.
    const lookup = input.createProvider.import?.bind(input.createProvider);
    if (lookup === undefined) return change;
    let found: Awaited<ReturnType<NonNullable<ResourceProvider['import']>>>;
    try {
      found = await this.withRetry(
        () =>
          lookup({
            logicalId,
            resourceType,
            stackName: input.stackName,
            region: this.stackRegion,
            properties: input.createProps,
            ...probe,
          }),
        logicalId,
        undefined,
        undefined,
        input.createProvider
      );
    } catch (probeError) {
      if (probeErrorMeansNameHeld(resourceType, probeError)) {
        throw markNonRetryable(
          new CdkdError(
            maskSecretsInText(
              `${subject} requires replacement, and S3 answered 403 Forbidden for bucket ` +
                `${displaySafe(change.desiredName)}: another account owns that name, or a bucket ` +
                `of this account denies this identity \`s3:ListBucket\`, or the request's ` +
                `credentials were rejected. Nothing was created or deleted. Choose another name, ` +
                `or if the bucket is yours grant \`s3:ListBucket\` on it (or delete it) and ` +
                `re-run.`,
              secrets
            ),
            'NAMED_REPLACEMENT_COLLISION',
            probeError instanceof Error ? probeError : undefined
          )
        );
      }
      throw markNonRetryable(
        new CdkdError(
          maskSecretsInText(
            `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd could ` +
              `not check whether another resource already holds it: ` +
              `${displayAwsMessage(maskSecretsInText(probeError instanceof Error ? probeError.message : String(probeError), secrets))}. ` +
              `Nothing was created or deleted. Re-run the deploy once the check can succeed.`,
            secrets
          ),
          'NAMED_REPLACEMENT_COLLISION',
          probeError instanceof Error ? probeError : undefined
        )
      );
    }
    if (found === null) return change;
    if (
      !typeChanged &&
      probeFoundSameId(resourceType, found.physicalId, currentResource.physicalId)
    ) {
      return undefined;
    }
    throw markNonRetryable(
      new CdkdError(
        maskSecretsInText(
          `${subject} requires replacement, and another existing resource ` +
            `(${displaySafe(found.physicalId)}) already holds the name it asks for. ` +
            `${renderReplacementNameChange(change, input.createProps)}. Since ${adoptsText}, creating the replacement ` +
            `would take that resource over and record it as this stack's. Nothing was ` +
            `created or deleted. Choose a name no other resource holds, or delete the ` +
            `resource holding it if it is yours.`,
          secrets
        ),
        'NAMED_REPLACEMENT_COLLISION'
      )
    );
  }

  /**
   * The create-first order for a replacement whose name is KNOWN to move off
   * the one the old resource holds (go-to-k/cdkd#3931): the `--recreate-via-*`
   * destroy-then-create and the UPDATE-not-supported fallback's DELETE →
   * CREATE delete first only to free a name the old resource holds, and here
   * it holds another. Deleting first freed nothing, so when another resource
   * held the new name the create collided with the managed resource already
   * gone. Now the old resource is deleted only once its replacement exists,
   * and a collision refuses with nothing deleted.
   *
   * The final-snapshot gate runs BEFORE the create, so its refusals still
   * change nothing; the delete after it is the property-driven cleanup's
   * ({@link deleteReplacedAfterCreate}).
   */
  private async createFirstThenDeleteOld(input: {
    logicalId: string;
    resourceType: string;
    oldResourceType: string;
    currentResource: ResourceState;
    createProvider: ResourceProvider;
    createProps: Record<string, unknown>;
    deleteProvider: ResourceProvider;
    deleteProperties: Record<string, unknown>;
    secrets: RecordedSecretValues;
    change: ReplacementNameChange;
    /** An equal physical id on the two halves names the SAME resource. */
    equalIdIsSameResource: boolean;
    snapshotPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    deletePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    /** What forced the replacement, for the refusals. */
    trigger: string;
    /** `UpdateReplacePolicy: Retain`: create only, the old resource stays. */
    retainOld?: boolean;
  }): Promise<ResourceCreateResult> {
    const { logicalId, resourceType, currentResource, secrets } = input;
    const retainOld = input.retainOld === true;
    // Before the create, so a refusal changes nothing. A PRE_DELETE_SNAPSHOT
    // type would take its snapshot here, before the create window; none of
    // them has a name `replacementRequestsDifferentName` reads, so none
    // reaches this method.
    const finalSnapshotIdentifier = retainOld
      ? undefined
      : await this.prepareFinalSnapshotForDelete(
          logicalId,
          input.oldResourceType,
          currentResource,
          input.snapshotPolicy
        );
    this.logger.info(
      retainOld
        ? safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource (the old one is retained)...`
        : safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource before deleting the old one...`
    );
    let createResult: ResourceCreateResult;
    try {
      createResult = await this.withRetry(
        () =>
          withCurrentResourceSecrets(secrets, () =>
            input.createProvider.create(logicalId, resourceType, input.createProps, {
              maskSecrets: createSecretMasker(secrets),
            })
          ),
        logicalId,
        undefined,
        undefined,
        input.createProvider
      );
    } catch (createError) {
      // The old resource is untouched: a raw failure is the whole story.
      if (!isNameCollisionErrorFrom(createError, logicalId)) throw createError;
      const createMsg = displayAwsMessage(
        maskSecretsInText(
          createError instanceof Error ? createError.message : String(createError),
          secrets
        )
      );
      // Marked: the message quotes the collision text, which the recreate
      // retry classifier would otherwise retry for minutes.
      throw markNonRetryable(
        new CdkdError(
          maskSecretsInText(
            `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
              `(${input.trigger}), and cdkd created the new resource first because its name ` +
              `differs, but the create collided: ${createMsg}. If the collision is on the ` +
              `requested name: ${renderReplacementNameChange(input.change, input.createProps)}. Nothing was deleted` +
              (retainOld ? ` (UpdateReplacePolicy: Retain keeps the old resource in place)` : '') +
              `. Choose a name no other resource holds, or delete the resource holding it if it ` +
              `is yours.`,
            secrets
          ),
          'NAMED_REPLACEMENT_COLLISION',
          createError instanceof Error ? createError : undefined
        )
      );
    }
    if (input.equalIdIsSameResource && createResult.physicalId === currentResource.physicalId) {
      // A name-idempotent create handed the old resource back, so it holds the
      // requested name after all and deleting it would delete the "new" one.
      throw markNonRetryable(
        new CdkdError(
          maskSecretsInText(
            `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
              `(${input.trigger}) under a new name, but the create returned the resource being ` +
              `replaced (${displaySafe(currentResource.physicalId)}) instead of a new one, so ` +
              `cdkd cannot tell which name it holds. Nothing was deleted. Delete that resource ` +
              `by hand if it is yours, then re-run the deploy.`,
            secrets
          ),
          'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
        )
      );
    }
    if (retainOld) return createResult;
    this.logger.info(safeMsg`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
    await this.deleteReplacedAfterCreate(
      logicalId,
      input.oldResourceType,
      currentResource,
      input.deleteProvider,
      input.deleteProperties,
      finalSnapshotIdentifier,
      input.deletePolicy,
      secrets
    );
    return createResult;
  }

  /**
   * The delete of a replaced resource once its replacement EXISTS. A failure
   * or a skip warns rather than fails the resource (issue #1762): the new
   * resource is created and about to be recorded, so the old one is untracked
   * either way, and failing here would roll back a replacement that
   * succeeded. Neither is recorded as a retention (issue #2631). The delete
   * error is masked with `secrets` BEFORE it is rendered: a provider can echo
   * a resolved value.
   */
  private async deleteReplacedAfterCreate(
    logicalId: string,
    oldResourceType: string,
    currentResource: ResourceState,
    deleteProvider: ResourceProvider,
    deleteProperties: Record<string, unknown>,
    finalSnapshotIdentifier: string | undefined,
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
    secrets: RecordedSecretValues
  ): Promise<void> {
    // Initialized because the catch below can leave it unassigned.
    let deleteResult: void | ResourceDeleteResult = undefined;
    let deleteFailed = false;
    try {
      deleteResult = await deleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        oldResourceType,
        deleteProperties,
        {
          expectedRegion: this.stackRegion,
          forceDataDelete: this.options.forceStatefulRecreation === true,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          ...this.replacementDeleteContext(updateReplacePolicy),
          // Issue #4157: the identity evidence of the record deleted.
          recordedAttributes: currentResource.attributes,
        }
      );
    } catch (deleteError) {
      const deleteMsg = maskSecretsInText(
        deleteError instanceof Error ? deleteError.message : String(deleteError),
        secrets
      );
      deleteFailed = true;
      // Always a warning, a not-found included: an "already gone" read off the
      // MESSAGE cannot be made safe (go-to-k/cdkd#3236) — a logical id like
      // `PageNotFound`, or a delete failing on a KMS key or role "not found"
      // while the old resource is alive, would silence the one line telling
      // the user an untracked resource may be left.
      this.logger.warn(
        safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}`
      );
    }
    const skipReason = deleteSkipReason(deleteResult);
    if (skipReason !== undefined) {
      this.logger.warn(
        `  ⚠ ${deleteSkippedMessage(
          logicalId,
          currentResource.physicalId,
          skipReason,
          'while cleaning up the replaced resource'
        )}. Delete it manually — it is no longer tracked in state.`
      );
    } else if (!deleteFailed) {
      this.logger.info(`  ${green('✓')} Old resource deleted`);
    }
  }

  /**
   * Inner body of provisionResource, extracted so the outer wrapper can
   * apply the per-resource deadline (`withResourceDeadline`) without
   * having the timeout / warn timer code dwarf the real provisioning
   * logic. Behaviour is unchanged from the pre-deadline implementation.
   */
  private async provisionResourceBody(
    logicalId: string,
    change: ResourceChange,
    stateResources: Record<string, ResourceState>,
    stackName: string,
    template?: CloudFormationTemplate,
    parameterValues?: Record<string, unknown>,
    conditions?: Record<string, boolean>,
    counts?: ProvisionCounts,
    progress?: { current: number; total: number }
  ): Promise<ResourceOutcomeSignal | void> {
    const resourceType = change.resourceType;
    // Existing state record (UPDATE / DELETE) — load-bearing for the
    // sticky `provisionedBy` routing introduced in #614: a resource
    // first created via Cloud Control (because its template had
    // silent-drop properties at the time) stays on Cloud Control for
    // every subsequent update / delete, even if the SDK provider has
    // since gained property coverage.
    const existingState = stateResources[logicalId];
    const renderer = getLiveRenderer();

    switch (change.changeType) {
      case 'CREATE': {
        const desiredProps = change.desiredProperties || {};

        // Resolve intrinsic functions in properties
        const context = this.buildResolverContext(
          {
            template: template!,
            resources: stateResources,
            ...(parameterValues && { parameters: parameterValues }),
            ...(conditions && { conditions }),
            // ONE OF THE TWO SITES THAT OPT IN. The bag's presence is what lets
            // the resolver skip a masked `Ref` state key, and this arm calls
            // `refuseRedactedAttributeReads` below — the reader that makes the
            // skip safe. See the field's doc on `buildResolverContext`.
            redactedAttributeReads: [],
          },
          stackName
        );

        // Store the secrets substituted during THIS resource's resolution so the
        // save choke point (and the async observed-capture drain) redact this
        // record only with its own secrets (GHSA fix — see perResourceSecrets).
        //
        // Issue #2038 review: registered BEFORE `resolve`, not after. The
        // resolver MUTATES `context.recordedSecretValues` in place, so the map
        // this line publishes is the very one the resolution fills — but a
        // throw from INSIDE `resolve()`, after a secret was already
        // substituted, used to reach the catch in this method with NO entry for
        // this resource, so the error line, the durable event and the
        // `ProvisioningError` cause all masked against an EMPTY bag. No
        // resolver throw is known to inline a resolved value, so this closes a
        // WINDOW rather than a demonstrated leak. The hoist cannot expose a
        // STALE bag: the map is keyed by logical id, `deploy()` resets it per
        // run, and each logical id is provisioned once — so this key has no
        // prior entry and the only thing another reader can observe earlier is
        // this resource's own map, empty, which every masking site treats
        // identically to an absent entry.
        if (context.recordedSecretValues) {
          this.perResourceSecrets.set(logicalId, context.recordedSecretValues);
        }
        const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
          string,
          unknown
        >;
        // Issue #2274: before ANY of the resolved bag reaches a provider, refuse
        // if the resolution had to serve an attribute a previous deploy
        // redacted. See the helper — the value would be the literal `***`.
        this.refuseRedactedAttributeReads(logicalId, resourceType, context);
        // Capture the UNRESOLVED bag as the redaction position source (#1904).
        this.perResourceTemplateProps.set(logicalId, desiredProps);
        this.perResourceResolvedType.set(logicalId, resourceType);
        // Named so the provider call below can bind the SAME bag into its
        // masker (issue #1932 item 3), mirroring `updateSecrets` on the UPDATE
        // path. `?? new Map()` rather than a conditional: `buildResolverContext`
        // always sets the field, so the fallback is unreachable in practice,
        // but a masker bound to a real map is what keeps the provider call
        // shape identical on both paths.
        const createSecrets = context.recordedSecretValues ?? new Map<string, string>();
        // Issue #2291: for an `AWS::CloudFormation::Stack` row, remember which
        // `{{resolve:...}}` expression each `Parameters` entry was resolved
        // FROM, keyed by the child's parameter NAME. The bag above is keyed by
        // PLAINTEXT, so two parameters resolving to one value have already
        // collapsed there — the parent's own template is the only uncollapsed
        // source left, and this is the last point at which both it and the
        // resolved values are in hand. `withCurrentResourceSecrets` binds THIS
        // bag around the provider call below, so the child engine reads the
        // associations off the same object. No-op for every other type.
        recordNestedStackParameterExpressions(
          createSecrets,
          resourceType,
          resolvedProps,
          desiredProps
        );

        this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

        // #1198: snapshot the attempted (resolved) properties so a failed
        // CREATE can be journaled with what it tried to apply.
        this.attemptedResolvedProps.set(logicalId, resolvedProps);

        // #614 routing: consult the registry with the resolved properties.
        // If the SDK provider would silent-drop a top-level key (and the
        // user has not overridden it via `--allow-unsupported-properties`),
        // we auto-route via Cloud Control API. The chosen `provisionedBy`
        // is persisted on state so the next update / delete uses the
        // same layer.
        const createDecision = this.providerRegistry.getProviderFor({
          resourceType,
          properties: resolvedProps,
        });
        const createProvider = createDecision.provider;
        const createProps =
          createDecision.provisionedBy === 'cc-api'
            ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
            : resolvedProps;

        const result = await this.withRetry(
          () =>
            // Issue #1903: the SAME bag, bound to this call's async chain so
            // `NestedStackProvider` can seed it into the child engine it
            // builds. Inside the retry arrow, so every attempt is scoped.
            withCurrentResourceSecrets(createSecrets, () =>
              createProvider.create(logicalId, resourceType, createProps, {
                // Issue #1932 item 3. The bag handed to the provider is RESOLVED,
                // so a `{{resolve:secretsmanager:...}}` property is plaintext by
                // now; a provider that echoes one into its own warn is outside
                // both existing masking boundaries (this engine's error/reason
                // text and the resolver's debug line). Give it the capability
                // rather than the bag — see `SecretMaskingContext`.
                maskSecrets: createSecretMasker(createSecrets),
              })
            ),
          logicalId,
          undefined,
          undefined,
          createProvider
        );

        // Issue #2274: BEFORE the record is built, so the needles exist by the
        // time anything is persisted, and before any dependent resolves against
        // this resource's fresh attributes.
        this.registerNoEchoAttributes(logicalId, result, createSecrets, resolvedProps);

        // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
        // so that deletion order is correct even without implicit type-based deps
        const dependencies = this.extractAllDependencies(template, logicalId);
        const templateAttrs = this.extractTemplateAttributes(template, logicalId);

        stateResources[logicalId] = {
          physicalId: result.physicalId,
          resourceType,
          properties: this.propertiesToRecord(
            resolvedProps,
            result,
            resourceType,
            createDecision.provisionedBy
          ),
          // The REAL attribute values, deliberately: this in-memory record is
          // what `Fn::GetAtt` serves to dependents in this same run, and
          // CloudFormation delivers a `NoEcho` custom resource's `Data` to a
          // dependent in the clear (issue #2274, measured). Masking happens at
          // the PERSIST choke point, from the needles registered above.
          ...(result.attributes && { attributes: result.attributes }),
          ...(dependencies && dependencies.length > 0 && { dependencies }),
          ...templateAttrs,
          provisionedBy: createDecision.provisionedBy,
        };
        this.recordInlinePolicyWrite(logicalId, 'create');

        const createCaptureSiblings = await this.buildObservedCaptureSiblings(
          resourceType,
          logicalId,
          result.physicalId,
          template,
          stateResources,
          stackName,
          parameterValues,
          conditions
        );
        this.kickOffObservedCapture(
          createProvider,
          logicalId,
          result.physicalId,
          resourceType,
          resolvedProps,
          { ...createCaptureSiblings, afterOwnWrite: true }
        );

        if (counts) counts.created++;
        if (progress) progress.current++;
        const createPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
        renderer.removeTask(logicalId);
        this.logger.info(
          `${createPrefix}${formatResourceLine('created', logicalId, resourceType)}`
        );
        break;
      }

      case 'UPDATE': {
        const currentResource = existingState;
        if (!currentResource) {
          throw new Error(`Cannot update ${logicalId}: resource not found in state`);
        }
        // Issue #2668: on a `Type` change the diff emits an UPDATE whose
        // `resourceType` is the TEMPLATE's (new) type, while the resource that
        // EXISTS is the state record's. The two halves of the replacement
        // route on different types: everything aimed at the OLD physical
        // resource (its delete, final snapshot, stateful guard) takes
        // `oldResourceType`, and the create takes `resourceType`. Design:
        // docs/design/2668-type-change-routing.md.
        const oldResourceType = currentResource.resourceType;
        const typeChanged = oldResourceType !== resourceType;

        const desiredProps = change.desiredProperties || {};
        const currentProps = change.currentProperties || {};
        // Issue #2750: the same bag with the keys the SDK route cannot have
        // WRITTEN removed. For a resource recorded on that route a silent-drop
        // key is junk by construction, and left in it makes the Cloud Control
        // auto-route inert on a record written before this fix:
        // `CloudControlProvider.update` builds its JSON Patch from the previous
        // side, finds the property identical on both sides, and omits it, so
        // the deploy reports success having sent nothing for it. A `cc-api`
        // record is left alone — Cloud Control sends the full map, so its bag
        // really does describe AWS.
        //
        // A SEPARATE binding rather than a narrowed `currentProps`, and the
        // scope is the point: only the two consumers that ask "what does AWS
        // hold, so what must this update send" take it — the no-op skip below
        // and the provider `update()` call. Everything else in this arm keeps
        // the RECORDED bag, in particular `isStatefulRecreateTargetForReplace`
        // (a data-loss guard, which asks what the resource HOLDS) and the
        // replacement path's `delete()` (whose providers read the recorded tags
        // to decide whether emptying is consented to). Narrowing those is inert
        // today — every key either reads is `handled` for its own type, fenced
        // by `tests/unit/provisioning/silent-drop-guard-key-disjointness.test.ts`
        // — but "inert today" is not a reason to widen a guard's input.
        const currentPropsAsWritten =
          currentResource.provisionedBy === 'cc-api'
            ? currentProps
            : withoutSilentDropProperties(resourceType, currentProps);

        // Resolve intrinsic functions in properties
        const context = this.buildResolverContext(
          {
            template: template!,
            resources: stateResources,
            ...(parameterValues && { parameters: parameterValues }),
            ...(conditions && { conditions }),
            // THE OTHER OPT-IN SITE — this arm calls
            // `refuseRedactedAttributeReads` below.
            redactedAttributeReads: [],
          },
          stackName
        );

        // Issue #2038 review: registered BEFORE `resolve`, same reason as the
        // CREATE path above — the resolver fills this map in place, and a throw
        // from inside `resolve()` after a substitution otherwise reaches the
        // shared catch with an empty bag.
        const updateSecrets = context.recordedSecretValues ?? new Map<string, string>();
        this.perResourceSecrets.set(logicalId, updateSecrets);
        const resolvedProps = (await this.resolver.resolve(desiredProps, context)) as Record<
          string,
          unknown
        >;
        // The #2274 refusal of a redacted read runs BELOW the no-change skip
        // (go-to-k/cdkd#3662), not here; see the note at that call.
        // Same position source on the UPDATE path (#1904).
        this.perResourceTemplateProps.set(logicalId, desiredProps);
        this.perResourceResolvedType.set(logicalId, resourceType);
        // Issue #2291: for an `AWS::CloudFormation::Stack` row, remember which
        // `{{resolve:...}}` expression each `Parameters` entry was resolved
        // FROM, keyed by the child's parameter NAME. The bag above is keyed by
        // PLAINTEXT, so two parameters resolving to one value have already
        // collapsed there — the parent's own template is the only uncollapsed
        // source left, and this is the last point at which both it and the
        // resolved values are in hand. `withCurrentResourceSecrets` binds THIS
        // bag around the provider call below, so the child engine reads the
        // associations off the same object. No-op for every other type.
        recordNestedStackParameterExpressions(
          updateSecrets,
          resourceType,
          resolvedProps,
          desiredProps
        );

        this.auditResolvedAssetReferences(logicalId, resourceType, resolvedProps);

        // Re-check diff after resolving intrinsic functions
        // DiffCalculator compares unresolved template vs resolved state, which may produce false positives.
        // Compare the REDACTED resolved bag (secret plaintext -> `{{resolve:...}}`
        // expression) against the stored side, which also holds the expression
        // (GHSA fix): a rotated secret behind an unchanged reference is a no-op,
        // matching CloudFormation, rather than a spurious UPDATE every deploy.
        // POSITIONED by the same template bag the persist path uses (#1910):
        // `currentProps` comes from state, which since #1904 holds each leaf's
        // OWN expression, so a value-only redaction here collapses a coinciding
        // pair onto the survivor and the comparison can never match — a
        // redundant UPDATE on every deploy of such a resource.
        //
        // `currentPropsAsWritten`, not the recorded bag (issue #2750): on a
        // record a pre-fix binary poisoned, the never-written key is present on
        // BOTH sides here, so the recorded bag makes this skip fire and the
        // deploy short-circuits before any provider is chosen — the auto-route
        // never runs and the property still does not reach AWS. This is the
        // second gate the healing path has to clear, after the diff's own.
        //
        // Issue #2516: the compared bag is a marked shallow COPY of the resolved
        // bag. The stored side holds an embedded 1-3 character secret as its
        // token once a deploy under this fix has written it, and the desired
        // side can only match that spelling if the walk knows the bag is this
        // pass's own — otherwise the leaf reads `port:42` against
        // `port:{{resolve:...}}` and the resource takes a redundant UPDATE on
        // every deploy. A COPY rather than `resolvedProps` itself, because the
        // mark is permanent on its object and the provider call below has not
        // happened yet: `propertiesToRecord` decides, after it, whether the
        // object state holds earns the mark.
        //
        // Issue #2809: the DESIRED operand is narrowed too, so the two sides
        // describe the same thing. `currentPropsAsWritten` removed the silent
        // drops the SDK route cannot have written; left alone, the desired side
        // still carried an allow-listed REMOVABLE drop, the strings could never
        // be equal, and this skip — with the attribute-only branch nested inside
        // it — was unreachable for such a resource. That cost a redundant
        // `provider.update()`, and on a type whose `update()` re-creates
        // (`AWS::SNS::Subscription`, where `Region` is such a drop) it turned a
        // `DeletionPolicy`-only flip into a destroy-and-recreate.
        //
        // The ALLOW SET rather than every removable drop: the diff's own
        // desired-side rule (`DiffCalculator`, issue #2750), deliberately NOT
        // the record side's. An un-allowed drop auto-routes the resource to
        // Cloud Control, which DOES write the key, so removing it here would
        // hide a real difference and skip an update that must be sent; the
        // helper removes nothing at all while any drop is un-allowed, since the
        // route is per resource. Skipped for a RECORD on 'cc-api' -- the same
        // recorded-marker test `currentPropsAsWritten` makes (an absent marker
        // counts as SDK), so both operands are narrowed for the same records.
        // `?.()` for the test doubles, as at the diff call: a double without
        // the method compares the full bag.
        //
        // The recreate flags are read below this skip (the issue #2651 class),
        // but for a resource whose TYPE is unchanged a `--recreate-via-*`
        // target this narrowing could absorb is not reachable from the CLI:
        // `--recreate-via-cc-api` with `--prefer-sdk-route` on the same
        // resource is `ambiguousIntent` whenever the template carries the
        // allow-listed drop (a check made against the RECORDED type), and
        // `--recreate-via-sdk-provider` is `blockedAlreadySdk` for every record
        // not on 'cc-api', a superset of the records narrowed here (which also
        // need an allow set and a removable drop). Both refuse at pre-flight
        // with `RECREATE_TARGETS_INVALID` -- see
        // `src/deployment/recreate-targets.ts`. A TYPE change does reach this
        // arm (the diff emits it as an UPDATE carrying `Type`), and this skip
        // compares properties only — so it is gated on `!typeChanged` below
        // (issue #3036): two types whose bags compare equal are still two
        // different resources, and skipping left AWS and the record on the OLD
        // type under a green deploy.
        //
        // The MASK-ONLY class is the exception to "compare the redacted bag"
        // (go-to-k/cdkd#3662). A `NoEcho` custom resource's value redacts to
        // `***`, which identifies nothing, so `***` equal to a recorded `***`
        // says nothing about the value: a handler that re-ran in THIS deploy and
        // returned a new token compared equal, the update was skipped, and the
        // live resource kept the old token under a green deploy. A resolved
        // bag carrying a `NoEcho` value supplied in THIS deploy (a handler
        // that ran in this process, or an output recovered from one) therefore
        // never takes the skip; a value from an earlier run resolves as the
        // mask itself, a redacted read. Only that population counts: the
        // mask-only class also holds DERIVED needles (`Fn::Base64` over a
        // `{{resolve:...}}` input), and counting those updated such a resource
        // on every deploy. The cost is a redundant update when the handler
        // returned the same value: the record holds only the mask, so there is
        // nothing here to compare the value with. A create-only property is the
        // exception, where the cost would be a REPLACEMENT: the ceiling block
        // below reads the resource back from AWS to decide that one
        // (go-to-k/cdkd#3729).
        const suppliesFreshMaskOnlyValue = carriesFreshNoEchoValue(resolvedProps, updateSecrets);
        const desiredForSkipCheck = redactSecretsForState(
          markSameGenerationBag({ ...resolvedProps }),
          updateSecrets,
          desiredProps
        );
        const allowedSilentDrops = this.providerRegistry.getAllowedUnsupportedProperties?.();
        const desiredForSkipCheckAsWritten =
          currentResource.provisionedBy !== 'cc-api' && allowedSilentDrops
            ? withoutAcceptedSilentDropProperties(
                resourceType,
                desiredForSkipCheck,
                allowedSilentDrops,
                currentResource.properties
              )
            : desiredForSkipCheck;
        // The metadata-only arm both no-change skips share: refresh the record's
        // template attributes and call no provider.
        const applyAttributeOnlyUpdate = (
          attributeChanges: NonNullable<typeof change.attributeChanges>
        ): void => {
          const attrSummary = attributeChanges
            .map((a) => `${a.attribute}: ${a.oldValue ?? '(unset)'} → ${a.newValue ?? '(unset)'}`)
            .join(', ');
          this.logger.info(
            safeMsg`  ↻ ${logicalId} (${resourceType}) attribute update: ${attrSummary}`
          );
          stateResources[logicalId] = {
            ...currentResource,
            ...this.extractTemplateAttributes(template, logicalId),
          };
          if (counts) counts.updated++;
          if (progress) progress.current++;
          const attrPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          this.logger.info(
            safeMsg`${attrPrefix}${formatResourceLine('updated', logicalId, resourceType, 'updated (metadata)')}`
          );
        };
        if (
          !typeChanged &&
          !suppliesFreshMaskOnlyValue &&
          keyOrderFreeJson(desiredForSkipCheckAsWritten) === keyOrderFreeJson(currentPropsAsWritten)
        ) {
          // Attribute-only change (schema v5+): `DeletionPolicy` /
          // `UpdateReplacePolicy` may have flipped without any AWS-side
          // property change. There is no per-resource AWS API for those —
          // refresh cdkd state alone and skip the provider call.
          if (change.attributeChanges && change.attributeChanges.length > 0) {
            applyAttributeOnlyUpdate(change.attributeChanges);
            break;
          }
          this.logger.debug(
            `Skipping ${logicalId}: no actual changes after intrinsic function resolution`
          );
          if (counts) counts.skipped++;
          break;
        }

        // Issue #2274: the UPDATE twin of the CREATE arm's refusal — same
        // reason, and needed on BOTH because an existing dependent whose OTHER
        // properties changed is the commonest way to reach a redacted read.
        //
        // AFTER the no-change skip, not before it (go-to-k/cdkd#3662). The
        // refusal exists so the literal `***` is never SENT; a skip sends
        // nothing and leaves the record as it was. Refusing first failed a
        // deploy over a dependent the diff promoted only speculatively (a
        // reader of a nested stack's `Outputs.<Key>`, issue #3631) whose
        // resolved bag, masked read included, equals its record. A redacted
        // read resolves to the literal mask, so it passes the skip only where
        // the record holds the mask at that same position and nothing else
        // moved, which is exactly the case with nothing to send.
        this.refuseRedactedAttributeReads(logicalId, resourceType, context);

        // #1198: snapshot the attempted (resolved) properties so a failed
        // UPDATE can be journaled with what it tried to apply (load-bearing
        // for the --revert-failed patch generation). Below the refusal, as it
        // was before the refusal moved: a refused UPDATE attempted nothing.
        this.attemptedResolvedProps.set(logicalId, resolvedProps);

        // A synthetic change's `requiresReplacement` is a CEILING
        // (go-to-k/cdkd#3662): the diff promoted this reader because an
        // attribute it reads MAY move (`inPlacePropagated`, e.g. a custom
        // resource's `Data`, a nested stack's outputs) or because a resource it
        // references was to be replaced (`replacementPropagated`), and a
        // create-only reading property then asked for a replacement whatever
        // the value turned out to be. The skip above only covers a reader with
        // NOTHING else moving; once another property changes, an unmoved value
        // would have destroyed and re-created the resource. The resolved value
        // is in hand now, so a path whose redacted value equals the record is
        // lowered to an in-place change.
        //
        // A path carrying a `NoEcho` value supplied in this deploy needs a
        // second witness (go-to-k/cdkd#3729). Its record holds `***`, and the
        // mask identifies nothing, so equal redacted values say only that the
        // OTHER leaves did not move. The resource is read back from AWS (once,
        // however many such paths it has), and the ceiling is lowered only when
        // AWS holds exactly this value at every fresh position. Nothing
        // derived from the value is stored, so there is nothing in state to
        // guess against. Every case the readback cannot confirm keeps the
        // replacement: no readback for the type, a write-only property, a
        // failed or slow read, or a different value.
        //
        // The same witness answers one change that is NOT a ceiling: a
        // create-only path the diff called changed only because it compared a
        // fresh `NoEcho` plaintext with the recorded `***`. A consumer's
        // `Fn::ImportValue` of a masked output this process recovered is that
        // shape. Such a path enters this block only when it holds a fresh leaf
        // AND its redacted value equals the record, so a real edit anywhere
        // else in it keeps the replacement exactly as before.
        // The paths whose fresh `NoEcho` leaves AWS confirmed, for the skip
        // below the block.
        const noEchoHeldPaths = new Set<string>();
        if (change.propertyChanges?.some((pc) => pc.requiresReplacement) === true) {
          let readback: Promise<FreshNoEchoReadback> | undefined;
          const lowered: PropertyChange[] = [];
          for (const pc of change.propertyChanges) {
            if (!pc.requiresReplacement) {
              lowered.push(pc);
              continue;
            }
            const freshLeaves = freshNoEchoLeafPositions(resolvedProps[pc.path], updateSecrets);
            if (!isReplacementCeiling(pc) && freshLeaves.length === 0) {
              lowered.push(pc);
              continue;
            }
            // The non-NoEcho half first, unchanged: a moved leaf keeps the
            // replacement whatever AWS holds at the masked ones.
            const moved =
              keyOrderFreeJson(desiredForSkipCheckAsWritten[pc.path]) !==
              keyOrderFreeJson(currentPropsAsWritten[pc.path]);
            // A propagated CEILING whose value MOVED is kept, unless the type's
            // own conditional rule reads the move as in place (issue #4134) --
            // the same predicate the diff applies to a template edit. A
            // property with no conditional rule answers `undefined` and keeps
            // it; a template-diff replacement is the diff's verdict already.
            const conditionalVerdict =
              moved && !typeChanged && isReplacementCeiling(pc)
                ? this.diffCalculator.conditionalReplacementVerdict?.(
                    resourceType,
                    pc.path,
                    currentPropsAsWritten[pc.path],
                    desiredForSkipCheckAsWritten[pc.path]
                  )
                : undefined;
            if (moved && conditionalVerdict !== false) {
              lowered.push(pc);
              continue;
            }
            if (freshLeaves.length > 0) {
              // A Type change replaces anyway, and the record's provider
              // describes the OLD type: no read, and nothing to report.
              if (typeChanged) {
                lowered.push(pc);
                continue;
              }
              readback ??= this.readReaderForFreshNoEchoCeiling(
                logicalId,
                currentResource,
                updateSecrets
              );
              const read = await readback;
              let verdict: FreshNoEchoCeilingVerdict;
              if ('failure' in read) {
                verdict = read.failure;
              } else if (!Object.prototype.hasOwnProperty.call(read.live, pc.path)) {
                verdict = 'not-readable';
              } else {
                verdict = liveHoldsFreshLeaves(read.live[pc.path], freshLeaves)
                  ? 'held'
                  : 'differs';
              }
              if (verdict !== 'held') {
                // WARN, not debug: this is what turns the update into a
                // replacement, and a `Replacing` label must never be
                // unexplained. The id, the path and the class only.
                this.logger.warn(
                  safeMsg`${logicalId}.${pc.path} carries a NoEcho value that AWS could not confirm unchanged (${verdict}): replacement kept.`
                );
                lowered.push(pc);
                continue;
              }
              this.logger.debug(
                safeMsg`${logicalId}.${pc.path} carries a NoEcho value AWS already holds: not replaced.`
              );
              noEchoHeldPaths.add(pc.path);
            }
            lowered.push({ ...pc, requiresReplacement: false });
          }
          change.propertyChanges = lowered;
        }

        // The no-change skip above could not trust the mask. Once AWS has
        // confirmed every fresh `NoEcho` leaf the bag carries, and every other
        // leaf equals the record, there is nothing to send, so the same skip
        // applies here. Without it the provider would be called with an
        // unchanged bag: a redundant update, or, for a type with no update API
        // (`AWS::Lambda::LayerVersion`), a refusal the update-failure fallback
        // turns back into the replacement this block just avoided. A fresh
        // leaf outside a confirmed path (an updatable property nobody read
        // back) keeps the update, as before (go-to-k/cdkd#3729).
        //
        // A `--recreate-via-*` target is never skipped here: before this skip
        // existed a fresh value always reached the recreate below, and a named
        // recreate must not be dropped because a value turned out unchanged.
        // An attribute-only change (`DeletionPolicy`, ...) takes the same
        // metadata arm as the skip above, for the same no-update-API reason.
        if (
          noEchoHeldPaths.size > 0 &&
          !typeChanged &&
          this.recreateDirectionFor(stackName, logicalId) === undefined &&
          keyOrderFreeJson(desiredForSkipCheckAsWritten) ===
            keyOrderFreeJson(currentPropsAsWritten) &&
          Object.entries(resolvedProps).every(
            ([key, value]) =>
              noEchoHeldPaths.has(key) ||
              freshNoEchoLeafPositions(value, updateSecrets).length === 0
          )
        ) {
          this.logger.debug(
            safeMsg`Skipping ${logicalId}: AWS already holds every NoEcho value it carries, and nothing else changed`
          );
          // Nothing was attempted, as on the skip above the refusal.
          this.attemptedResolvedProps.delete(logicalId);
          if (change.attributeChanges && change.attributeChanges.length > 0) {
            applyAttributeOnlyUpdate(change.attributeChanges);
            break;
          }
          if (counts) counts.skipped++;
          break;
        }

        // Check if this update requires resource replacement (immutable property changed)
        // `typeChanged ||` (issue #3036): a Type change is a replacement by
        // definition, never an in-place update — the in-place arm below would
        // hand the OLD physical id to the NEW type's `update()`. Read from the
        // record rather than trusted to the diff's synthetic `Type` row, so a
        // change-shape that omits the row cannot route there.
        const propertyDrivenReplacement =
          typeChanged || change.propertyChanges?.some((pc) => pc.requiresReplacement);
        // Issue [#2567] — the recreate targets apply ONLY to the stack the
        // pre-flight validated them against. This engine instance may be a
        // NESTED child (`NestedStackProvider.runChildDeploy` spreads the
        // parent's options into it, and the child deploys under
        // `<parent>~<logicalId>`), where the ids were never validated: neither
        // the child's template, nor its state record, nor its live emptiness
        // was ever looked at. Unscoped, a child resource sharing a logical id
        // with a validated parent one was treated as recreate-flagged — and
        // `recreateFlagged` is what SKIPS the stateful guard below.
        //
        // Read INSIDE `case 'UPDATE'`, and only after the no-op short-circuit
        // above: a named target whose diff is NO_CHANGE is silently ignored
        // (issue [#2651](https://github.com/go-to-k/cdkd/issues/2651)) -- which is also why any test or fixture measuring
        // this flag must give the target a real property change, or it
        // measures nothing.
        const recreateTargets =
          this.options.recreateTargets?.stackName === stackName
            ? this.options.recreateTargets
            : undefined;
        // Issue [#615] — the user explicitly named this resource via
        // `--recreate-via-cc-api <LogicalId>` so this deploy MUST destroy
        // + recreate it through Cloud Control regardless of whether the
        // template's diff would otherwise drive a replacement.
        const recreateViaCcApi = recreateTargets?.viaCcApi.has(logicalId) ?? false;
        // #651 reverse direction. Mutually exclusive with `recreateViaCcApi`
        // — the pre-flight validator rejects any logical id named in both
        // lists, so at most one of these two booleans is true at a time.
        const recreateViaSdkProvider = recreateTargets?.viaSdkProvider.has(logicalId) ?? false;
        const recreateFlagged = recreateViaCcApi || recreateViaSdkProvider;
        const needsReplacement = propertyDrivenReplacement || recreateFlagged;

        // The label `provisionResource` chose left ceilings out; one that
        // stood (the value moved, or it is a fresh `NoEcho` value AWS could
        // not confirm unchanged) turns this into a replacement, so say so.
        const liveLabel = this.liveTaskLabels.get(logicalId);
        if (needsReplacement && liveLabel !== undefined && !liveLabel.replacing) {
          const routing = this.peekRoutingForLabel(
            change,
            currentResource,
            stackName,
            logicalId,
            true,
            this.recreateDirectionFor(stackName, logicalId)
          );
          const label = `Replacing ${logicalId} (${resourceType})${routing === 'cc-api' ? ' [CC API]' : ''}`;
          this.liveTaskLabels.set(logicalId, {
            label,
            replacing: true,
            ...(liveLabel.warnSuffix !== undefined && { warnSuffix: liveLabel.warnSuffix }),
          });
          // Keep a slow-resource warning the deadline wrapper already added.
          renderer.updateTaskLabel(logicalId, `${label}${liveLabel.warnSuffix ?? ''}`);
        } else if (!needsReplacement && liveLabel !== undefined && liveLabel.replacing) {
          // The other direction (go-to-k/cdkd#3729): a create-only change the
          // label counted as a replacement was lowered above, because AWS
          // already holds the fresh `NoEcho` value there.
          const routing = this.peekRoutingForLabel(
            change,
            currentResource,
            stackName,
            logicalId,
            false,
            this.recreateDirectionFor(stackName, logicalId)
          );
          const label = `Updating ${logicalId} (${resourceType})${routing === 'cc-api' ? ' [CC API]' : ''}`;
          this.liveTaskLabels.set(logicalId, {
            label,
            replacing: false,
            ...(liveLabel.warnSuffix !== undefined && { warnSuffix: liveLabel.warnSuffix }),
          });
          renderer.updateTaskLabel(logicalId, `${label}${liveLabel.warnSuffix ?? ''}`);
        }

        // Extract ALL dependencies from template (Ref, Fn::GetAtt, DependsOn)
        const dependencies = this.extractAllDependencies(template, logicalId);

        // `UpdateReplacePolicy: Retain` orphans the OLD physical resource on a
        // replacement (the create-first path below leaves it in place — see the
        // "Retaining old" branch), so a property-driven replacement of a
        // Retain-policy resource loses NO data. Read it here so the stateful
        // guard can honor it, and reused by every later site that asks what
        // policy the user is applying NOW: the replace/delete sites below and
        // the update-failure fallback's `Retain` note. The ONE read that does
        // not use it is the fallback's SNAPSHOT read, which falls back to
        // `currentResource.updateReplacePolicy`; the reason is stated at that
        // call site.
        const updateReplacePolicy = template?.Resources?.[logicalId]?.UpdateReplacePolicy;

        if (needsReplacement) {
          // Stateful guard for PROPERTY-DRIVEN replacement (an immutable /
          // createOnly property changed in the template). DELETE+CREATEing a
          // stateful type (RDS / EFS / Secret / SSM Parameter / Kinesis / etc.)
          // loses all of its data, so — mirroring the `--replace` and
          // `--recreate-via-*` paths — require `--force-stateful-recreation` to
          // confirm the data loss. Only the property-driven case is gated here:
          // the `--recreate-via-*` flags run their own pre-flight stateful probe
          // (`probeStatefulRecreateTargetsAsync`) before the deploy, so a
          // recreate-flagged target has already been validated. Uses the
          // conservative mid-deploy variant (treats a non-probed S3 bucket, and
          // a log group whose recorded retention does not already settle it, as
          // stateful) since the diff loop has no chance to run the async
          // emptiness probes. A `Retain` UpdateReplacePolicy is exempt: the
          // old resource + its data survive the replacement (orphaned, not
          // deleted), so there is no data loss to confirm. `Snapshot` is NOT
          // exempt: cdkd DOES take a final snapshot on the replacement delete
          // (issue #1354), but a snapshot is a point-in-time copy, not a
          // surviving resource — the live resource is still destroyed and
          // recreated, so the consent flag is still the right gate.
          if (propertyDrivenReplacement && !recreateFlagged && updateReplacePolicy !== 'Retain') {
            // Three arguments, not two (issue [#2521]): the guard's log-group arm
            // reads a positive `RetentionInDays` out of EITHER recorded bag, so
            // the observed one -- where an out-of-band `put-retention-policy`, or
            // an import whose template never declared the property, puts it -- has
            // to travel with the recorded one. `currentProps` stays the recorded
            // bag exactly as before; `currentResource` is this UPDATE branch's
            // state record, the only place the observed bag exists.
            // The OLD type (issue #2668): the guard asks what the resource being
            // destroyed HOLDS, and that resource is the state record's. Keyed
            // on the template's type, a stateful-to-non-stateful Type change
            // escaped the guard entirely, and the reverse refused a deploy that
            // destroys nothing stateful.
            const statefulReason = isStatefulRecreateTargetForReplace(
              oldResourceType,
              currentProps,
              currentResource.observedProperties
            );
            if (statefulReason && this.options.forceStatefulRecreation !== true) {
              const immutableProps =
                change.propertyChanges
                  ?.filter((pc) => pc.requiresReplacement)
                  .map((pc) => pc.path)
                  .join(', ') || 'Type';
              // `markNonRetryable`: the verdict is computed from a CLI flag and
              // a state-recorded property bag, neither of which a retry can
              // change — and the message interpolates a template-controlled
              // logical id into text the SUBSTRING-matching retry classifiers
              // read. The twin marker sits on the update-failure fallback's
              // guard below; both are declarations, not fixes for an observed
              // retry (the throws are outside `withRetry` today, but a nested
              // stack's child engine re-throws into the parent's).
              throw markNonRetryable(
                new CdkdError(
                  `${logicalId} (${oldResourceType}) requires replacement (immutable property changed: ` +
                    `${immutableProps}${typeChanged ? `, to ${resourceType}` : ''}) but it is a stateful resource — ` +
                    `${renderStatefulReason(statefulReason)}. Re-run with ` +
                    `--force-stateful-recreation to confirm the data loss, or change the resource ` +
                    `definition to avoid the immutable-property change.`,
                  'STATEFUL_REPLACE_BLOCKED'
                )
              );
            }
          }

          // Issue #3899: `--recreate-via-cc-api` deletes the old resource FIRST
          // and then creates through Cloud Control, pinned by `forceCcApi`
          // below, which the registry honours before it consults whether Cloud
          // Control can create the type at all. `validateRecreateTargets`
          // refuses such a type pre-flight (#3887); this is the same verdict
          // at the delete, so a caller that skips the validator cannot delete
          // a resource that is then never recreated.
          if (recreateViaCcApi) {
            const noCcRoute = this.providerRegistry.ccRouteUnavailableReason(resourceType);
            if (noCcRoute !== undefined) {
              throw markNonRetryable(
                new CdkdError(
                  `--recreate-via-cc-api cannot recreate ${logicalId} (${resourceType}): Cloud ` +
                    `Control API cannot create this type (${noCcRoute}). Nothing was deleted. ` +
                    `Drop ${logicalId} from --recreate-via-cc-api.`,
                  'RECREATE_TARGETS_INVALID'
                )
              );
            }
            // Issue #4119: routing ignores the flag for this type, so the
            // recreate would delete and recreate it on the SDK route.
            const ccBroken = ccBrokenReason(resourceType);
            if (ccBroken !== undefined) {
              throw markNonRetryable(
                new CdkdError(
                  `--recreate-via-cc-api cannot move ${logicalId} (${resourceType}) to Cloud ` +
                    `Control: ${ccBroken}, so cdkd keeps it on its SDK provider. Nothing was ` +
                    `deleted. Drop ${logicalId} from --recreate-via-cc-api.`,
                  'RECREATE_TARGETS_INVALID'
                )
              );
            }
          }

          // Resource replacement: DELETE old → CREATE new
          let replacementReason: string;
          if (recreateViaCcApi) {
            replacementReason = '--recreate-via-cc-api flag (mid-life SDK→CC migration)';
          } else if (recreateViaSdkProvider) {
            // #651 reverse direction.
            replacementReason = '--recreate-via-sdk-provider flag (mid-life CC→SDK migration)';
          } else {
            replacementReason = `immutable properties changed: ${change.propertyChanges
              ?.filter((pc) => pc.requiresReplacement)
              .map((pc) => pc.path)
              .join(', ')}`;
          }
          this.logger.info(
            `Replacing ${logicalId} (${typeChanged ? `${oldResourceType} -> ${resourceType}` : resourceType}) - ${replacementReason}`
          );

          // The new (replacement) resource gets a fresh routing decision —
          // a property the SDK provider used to silent-drop may now be
          // wired, or vice versa. The OLD resource's delete uses the
          // state-recorded layer (sticky) so a CC-managed legacy is
          // deleted via CC even if the template now would land on SDK.
          //
          // When the recreate is driven by `--recreate-via-cc-api`, pass
          // an explicit `provisionedBy: 'cc-api'` hint so the routing
          // decision tree's rule 2 ("sticky CC") returns CC even when
          // the template itself has no silent-drop property. The new
          // physical id then stamps `provisionedBy: 'cc-api'` on state
          // and all subsequent ops stick to CC.
          //
          // #651: `--recreate-via-sdk-provider` is the reverse — force
          // `provisionedBy: 'sdk'` so the routing decision returns the
          // SDK provider even though the current state record sticks at
          // 'cc-api'. The new physical id stamps `provisionedBy: 'sdk'`.
          const recreateDirectionHint: 'sdk' | 'cc-api' | undefined = recreateViaCcApi
            ? 'cc-api'
            : recreateViaSdkProvider
              ? 'sdk'
              : undefined;
          const replaceDecision = this.providerRegistry.getProviderFor({
            resourceType,
            properties: resolvedProps,
            ...(recreateDirectionHint && { provisionedBy: recreateDirectionHint }),
            // Issue #3713: the baseline an unrecognized property is compared
            // against. A replacement mints a NEW physical resource, but one
            // replacing a resource that deployed with the key unchanged keeps
            // its route — on presence, a typo CloudFormation would reject but
            // the SDK route tolerated would fail the replacement instead.
            // Inert for the sticky-escape: without a `'cc-api'` record hint
            // rule 2 is not consulted, and with one `forceCcApi` pins it.
            previousProperties: currentResource.properties,
            // Issue #2719: `--recreate-via-cc-api` passes `provisionedBy:
            // 'cc-api'` as a HINT, and for a type with an `'sdk-coverage'`
            // exemption the sticky-escape would read that hint and divert the
            // resource straight back to the SDK provider -- turning the user's
            // explicit "recreate this through Cloud Control" into a no-op.
            // Pinning here is what keeps the flag meaning what it says.
            ...(recreateViaCcApi && { forceCcApi: true }),
          });
          const replaceProvider = replaceDecision.provider;
          const replaceProps =
            replaceDecision.provisionedBy === 'cc-api'
              ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
              : resolvedProps;

          // Order: property-driven replacement (immutable prop changed)
          // creates the NEW resource first so the old survives a CREATE
          // failure — matches CFn's safe-replacement order. The
          // `--recreate-via-cc-api` flag (#615) instead destroys the OLD
          // resource first: the user-named recreate target almost always
          // has a user-supplied physical name (e.g. `functionName: 'foo'`),
          // and a create-first attempt with the same name collides with
          // the existing resource. Brief deletion-window downtime is the
          // explicit cost of opting into recreate; the design doc § 2
          // calls this out as "Old physical resource: destroyed via SDK
          // Provider ... New physical resource: created via CC API",
          // i.e. destroy-then-create — except when the template also renames
          // the target (go-to-k/cdkd#3931): the old resource then does not
          // hold the new name, so `createFirstThenDeleteOld` creates first.
          // (`updateReplacePolicy` is read once above, before the stateful
          // guard, and reused here.)
          //
          // Issue #2668: BOTH inputs come from the state record. The layer
          // always did; the TYPE used to be the template's, so on a Type change
          // the old resource's delete was dispatched at the NEW type's provider
          // — a loud API error, a silent leak, or (where the two types'
          // physical-id namespaces overlap) the deletion of an unrelated live
          // resource of the new type.
          const oldDeleteProvider = this.providerRegistry.getProviderFor({
            resourceType: oldResourceType,
            provisionedBy: currentResource.provisionedBy,
          }).provider;

          // Whether an EQUAL physical id on the two halves names the SAME
          // resource — what the two name-idempotent guards below assume. True
          // within one type; across a Type change only for the custom-resource
          // family (`equalIdNamesSameResource` has the reasoning).
          const equalIdIsSameResource = equalIdNamesSameResource({
            oldType: oldResourceType,
            newType: resourceType,
            createLayer: replaceDecision.provisionedBy,
            // Issue #3892: a Glue table's id is placed by DatabaseName, so an
            // equal id can be a genuinely new table in another database.
            oldProperties: currentResource.properties,
            newProperties: resolvedProps,
            physicalId: currentResource.physicalId,
          });

          // go-to-k/cdkd#3937 / #3931: a name KNOWN to move off the one the old
          // resource holds, probed where the create would adopt a taken one.
          // Before any arm below creates or deletes anything.
          const nameChange = await this.checkedReplacementNameChange({
            logicalId,
            resourceType,
            oldResourceType,
            stackName,
            currentResource,
            desiredProperties: resolvedProps,
            createProvider: replaceProvider,
            createdVia: replaceDecision.provisionedBy,
            createProps: replaceProps,
            secrets: updateSecrets,
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shape varies by ResourceProvider impl
          let createResult: any;
          if (recreateFlagged && nameChange !== undefined) {
            // go-to-k/cdkd#3931: the destroy-then-create below exists to free
            // a name the old resource holds; this one moves to another, so the
            // old resource is deleted only once its replacement exists — and,
            // under Retain, a collision is refused at once rather than retried
            // as a late name release.
            const retainOld = updateReplacePolicy === 'Retain';
            const recreateFlagName = recreateViaCcApi
              ? '--recreate-via-cc-api'
              : '--recreate-via-sdk-provider';
            if (retainOld) {
              // Issue #2603, as on the destroy-then-create arm.
              this.retainedOldOnReplacement.add(logicalId);
              this.logger.warn(
                safeMsg`  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} leaves the old physical resource (${currentResource.physicalId}) in place, no longer tracked by cdkd.`
              );
            }
            createResult = await this.createFirstThenDeleteOld({
              retainOld,
              logicalId,
              resourceType,
              oldResourceType,
              currentResource,
              createProvider: replaceProvider,
              createProps: replaceProps,
              deleteProvider: oldDeleteProvider,
              deleteProperties: currentResource.properties,
              secrets: updateSecrets,
              change: nameChange,
              equalIdIsSameResource,
              snapshotPolicy: updateReplacePolicy,
              deletePolicy: updateReplacePolicy,
              trigger: recreateFlagName,
            });
          } else if (recreateFlagged) {
            // Destroy-then-create path. Same `UpdateReplacePolicy:
            // Retain` semantics — retained old resources leak (named the
            // same as the new); document via warning. CFn would refuse a
            // Retain + replace combo at template-author time; cdkd warns
            // and proceeds since the user explicitly opted in.
            const recreateFlagName = recreateViaCcApi
              ? '--recreate-via-cc-api'
              : '--recreate-via-sdk-provider';
            if (updateReplacePolicy === 'Retain') {
              // Issue #2603: the delete below is SKIPPED, so record that this
              // deploy left the old resource alive — the rollback classifier
              // reads this rather than re-deriving the verdict from the
              // previous state record's policy.
              this.retainedOldOnReplacement.add(logicalId);
              this.logger.warn(
                `  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — ${recreateFlagName} will ` +
                  `leak the old physical resource (${currentResource.physicalId}). The new ` +
                  `resource shares the same name where applicable; if the type ` +
                  `has user-supplied names (e.g. functionName, bucketName), the create will ` +
                  `deterministically collide with the retained orphan.`
              );
            } else {
              this.logger.info(
                `  Destroying old ${logicalId} (${currentResource.physicalId}) before recreate...`
              );
              // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
              // old resource before the recreate's delete. OUTSIDE the try
              // so a snapshot failure/refusal keeps its typed
              // FINAL_SNAPSHOT_* error instead of being rewrapped as a
              // delete failure that never happened.
              const recreateFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
                logicalId,
                oldResourceType,
                currentResource,
                updateReplacePolicy
              );
              let recreateDeleteResult: void | ResourceDeleteResult;
              try {
                recreateDeleteResult = await oldDeleteProvider.delete(
                  logicalId,
                  currentResource.physicalId,
                  oldResourceType,
                  currentResource.properties,
                  {
                    expectedRegion: this.stackRegion,
                    forceDataDelete: this.options.forceStatefulRecreation === true,
                    ...(recreateFinalSnapshotId !== undefined && {
                      finalSnapshotIdentifier: recreateFinalSnapshotId,
                    }),
                    ...this.replacementDeleteContext(updateReplacePolicy),
                    recordedAttributes: currentResource.attributes,
                  }
                );
              } catch (deleteError) {
                // Re-throw so the deploy engine's existing rollback path
                // sees the failure — recreate's destroy is load-bearing
                // (without it the subsequent create collides with the
                // pre-existing resource), so a swallowed failure would
                // produce a confusing AlreadyExists later.
                throw new Error(
                  `Failed to destroy old resource ${logicalId} (${currentResource.physicalId}) ` +
                    `during ${recreateFlagName}: ` +
                    `${deleteError instanceof Error ? deleteError.message : String(deleteError)}`
                );
              }
              // Issue #1762: same reasoning as the delete-first fallback —
              // this destroy is load-bearing, so a skip has to fail the
              // resource rather than let the create run beside a live old one.
              const recreateSkipReason = deleteSkipReason(recreateDeleteResult);
              if (recreateSkipReason !== undefined) {
                throw new Error(
                  deleteSkippedMessage(
                    logicalId,
                    currentResource.physicalId,
                    recreateSkipReason,
                    `during ${recreateFlagName}`
                  )
                );
              }
              this.logger.info(`  ${green('✓')} Old resource deleted`);
            }

            this.logger.info(`  Creating new ${logicalId}...`);
            // Delete-then-create just released the old resource's name, so
            // the re-create can hit a late name release ("already exists"
            // from an async delete) or the SQS 60s same-name cooldown
            // (QueueDeletedRecently, issue #1214). The inner retry matches
            // the cooldown — and since issue #2116 it rides the name-cooldown
            // grid (2s/4s/8s then 10s, ≈64s), not the generic ~47s one it used
            // to inherit, so the inner loop alone now covers the 60s window
            // rather than typically ending inside it.
            //
            // This outer loop is kept anyway, and the reason has MOVED rather
            // than disappeared: it is no longer "the inner budget is too
            // short" but that the outer filter is `isRecreateRetryableError`,
            // which also covers the late name RELEASE ("already exists" from
            // an async delete) that the inner default classifier deliberately
            // rejects. Note the two now COMPOUND — the outer loop re-enters an
            // inner loop that is itself 64s — measured at 640s total sleep on
            // a cooldown, inside the 30-minute per-resource deadline. See
            // `NAME_COOLDOWN_INITIAL_DELAY_MS` in retry.ts.
            createResult = await withRetry(
              () =>
                this.withRetry(
                  () =>
                    withCurrentResourceSecrets(updateSecrets, () =>
                      replaceProvider.create(logicalId, resourceType, replaceProps, {
                        maskSecrets: createSecretMasker(updateSecrets),
                      })
                    ),
                  logicalId,
                  undefined,
                  undefined,
                  replaceProvider
                ),
              logicalId,
              {
                maxRetries: 8,
                initialDelayMs: 2_000,
                maxDelayMs: 10_000,
                // Issue #2038, same reason as the --replace fallback above --
                // and bound to `updateSecrets`, the bag this UPDATE resolved
                // with and the very one the `createSecretMasker` one statement
                // up is built from, rather than looked up by logical id.
                logger: this.maskingRetryLoggerFor(updateSecrets),
                isInterrupted: () => this.interrupted,
                onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
                isRetryable: isRecreateRetryableError,
              }
            );

            // Issue #1238: under `UpdateReplacePolicy: Retain` the old
            // resource was NOT destroyed above, so a name-idempotent Create
            // API (e.g. SQS CreateQueue with an unchanged QueueName) can
            // silently return the EXISTING resource instead of colliding.
            // Recording that id as the "new" resource would re-adopt the
            // resource the Retain policy just orphaned — without the new
            // properties ever being applied. Fail before the state
            // bookkeeping runs; the old resource and its state record stay
            // intact.
            //
            // `equalIdIsSameResource` (issue #2668): across a Type change an
            // equal id is a coincidence of two namespaces, and the create was a
            // genuine one — the custom-resource family excepted.
            if (
              equalIdIsSameResource &&
              updateReplacePolicy === 'Retain' &&
              createResult.physicalId === currentResource.physicalId
            ) {
              throw new CdkdError(
                `${logicalId} (${resourceType}) recreate returned the existing resource ` +
                  `(${currentResource.physicalId}) instead of creating a new one — its Create ` +
                  `API is name-idempotent — and UpdateReplacePolicy: Retain means the old ` +
                  `resource was never destroyed, so the new properties were not applied. ` +
                  `Rename the resource in your CDK code (or remove the explicit physical ` +
                  `name) so the recreate can produce a genuinely new resource.`,
                'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
              );
            }
          } else {
            // Property-driven replacement: create-then-destroy (CFn
            // safe-replacement order — keeps the old alive if CREATE
            // fails so the deploy can roll back to it cleanly).
            this.logger.info(`  Creating new ${logicalId}...`);
            let deletedOldFirst = false;
            try {
              createResult = await this.withRetry(
                () =>
                  withCurrentResourceSecrets(updateSecrets, () =>
                    replaceProvider.create(logicalId, resourceType, replaceProps, {
                      maskSecrets: createSecretMasker(updateSecrets),
                    })
                  ),
                logicalId,
                undefined,
                undefined,
                replaceProvider
              );
            } catch (createError) {
              // The AWS text every refusal below quotes: masked FIRST (the
              // create was handed resolved values), then rendered display-safe
              // and bounded, since an AWS message can echo a template value.
              const createMsg = displayAwsMessage(
                maskSecretsInText(
                  createError instanceof Error ? createError.message : String(createError),
                  updateSecrets
                )
              );
              // A custom-named resource cannot be safely replaced: the
              // create-first attempt collides with the old resource still
              // holding the name. CloudFormation refuses this same shape
              // ("cannot update a stack when a custom-named resource
              // requires replacing"); surface an equally clear error —
              // with a working one-command escape hatch CFn lacks —
              // instead of the raw AlreadyExists (issue #960 follow-up).
              //
              // NOTE: the detection is a HEURISTIC — an "already
              // exists" raised by something other than the replaced
              // resource's own name (e.g. an externally-owned sibling)
              // also matches. So delete-first fires only under the explicit
              // --replace opt-in, targets only the state-recorded old
              // physicalId, after the stateful guard, and only once
              // `replacementOldHoldsSentName` proves that old resource holds
              // the name the create sent (issue #3979).
              // Reads the ERROR, not the rendered message: ELBv2 states the
              // collision in prose the message matcher cannot see and must not
              // be widened to see, and the name is dropped by the provider wrap
              // (issue go-to-k/cdkd#3208).
              const nameCollision = isNameCollisionErrorFrom(createError, logicalId);
              if (!nameCollision) throw createError;
              // Retain pins the old resource (and its name) in place, so a
              // same-name replacement can never proceed under any flag.
              // (Snapshot is not special-cased HERE — the old resource is
              // still deleted so the name frees up; the delete-first helper
              // takes its final snapshot first, issue #1354.)
              const nameOrigin = this.replacementNameOrigin(logicalId, currentResource.physicalId);
              // Issue #2668: across a Type change the old resource can hold the
              // name only where the two types share a name space; every other
              // pair is refused by the #3979 holder proof below, whose
              // diagnosis names both types.
              // Issue #3808: every message below, and the `--replace`
              // delete-first retry, presume the old resource holds the name.
              // When the template's explicit name says otherwise, the holder
              // is another resource: refuse under every flag and policy, since
              // deleting the old resource first would only destroy it and hit
              // the same collision. Nothing has been deleted at this point.
              const nameHeldElsewhere = replacementRequestsDifferentName({
                oldResourceType,
                newResourceType: resourceType,
                desiredProperties: resolvedProps,
                recorded: currentResource.properties,
                observed: currentResource.observedProperties,
                physicalId: currentResource.physicalId,
              });
              if (nameHeldElsewhere !== undefined) {
                // Marked: a template value and a recorded name decide it, and
                // the message quotes the create's collision text, which the
                // recreate retry classifier treats as retryable.
                throw markNonRetryable(
                  new CdkdError(
                    `${logicalId} (${resourceType}) requires replacement, but the create-first ` +
                      `attempt collided: ${createMsg}. ${renderNameHeldElsewhere(nameHeldElsewhere)}` +
                      (this.options.replace === true
                        ? ` — so --replace was NOT applied and nothing was deleted.`
                        : updateReplacePolicy === 'Retain'
                          ? ` — so removing UpdateReplacePolicy: Retain and re-running with ` +
                            `\`cdkd deploy --replace\` would delete this resource and still collide.`
                          : ` — so \`cdkd deploy --replace\` would delete this resource and still ` +
                            `collide.`) +
                      ` Choose a name no other resource holds, or delete the resource holding it if ` +
                      `it is yours.`,
                    'NAMED_REPLACEMENT_COLLISION',
                    // Chained like the fallback twin, so the persisted event
                    // names the AWS rejection; safe because the refusal is
                    // marked, which the retry classifiers read first.
                    createError instanceof Error ? createError : undefined
                  )
                );
              }
              // Issue #3979: the check above refuses only a KNOWN different
              // explicit name. With no name in the template, or one a
              // rewriting provider (IAM, ELBv2) sends under this deploy's
              // stack scope and prefix flag, the collision may be with an
              // orphan of an earlier attempt, a replayed create or a
              // squatter — and deleting the old resource then destroys a live
              // resource that never held the name, and collides again. So
              // prove the old resource holds the name the create SENT, here in
              // the create's own async scope, and refuse when it is not proven.
              // Ahead of the Retain and no-flag refusals too: both presume
              // the old resource holds the name, and the no-flag one advises
              // the `--replace` this check would then refuse.
              const holder = replacementOldHoldsSentName({
                createType: resourceType,
                holderType: oldResourceType,
                requested: replaceProps,
                // A nameless SDK create: the name the provider mints, trusted
                // only for a type audited to mint cdkd's rule verbatim.
                generated: applyDefaultNameForFallback(logicalId, resourceType, resolvedProps),
                recorded: currentResource.properties,
                observed: currentResource.observedProperties,
                physicalId: currentResource.physicalId,
                logicalId,
                createdVia: replaceDecision.provisionedBy,
                holderVia: currentResource.provisionedBy,
                mask: (value) => maskSecretsInText(value, updateSecrets),
              });
              if (!holder.holds) {
                const flagClause =
                  this.options.replace === true
                    ? ` --replace was NOT applied and nothing was deleted.`
                    : updateReplacePolicy === 'Retain'
                      ? ` Nothing was deleted. UpdateReplacePolicy: Retain keeps the resource ` +
                        `being replaced in place; removing it and re-running with ` +
                        `\`cdkd deploy --replace\` would refuse the same way rather than delete it.`
                      : ` Nothing was deleted, and \`cdkd deploy --replace\` would refuse the ` +
                        `same way rather than delete it.`;
                throw markNonRetryable(
                  new CdkdError(
                    // Masked at construction: the create's collision text can
                    // echo a resolved value.
                    maskSecretsInText(
                      `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires ` +
                        `replacement, but the create-first attempt collided: ${holder.diagnosis} — ` +
                        (holder.known
                          ? `so another resource holds the colliding name (an orphan of an ` +
                            `earlier attempt, or one made outside this stack), and deleting the ` +
                            `resource being replaced would destroy it and collide again.` +
                            flagClause +
                            ` Remove or rename the resource holding that name if it is yours, ` +
                            `then re-run the deploy.`
                          : `so if another resource holds it (an orphan of an ` +
                            `earlier attempt, or one made outside this stack), deleting the ` +
                            `resource being replaced would destroy it and collide again.` +
                            flagClause +
                            ` Remove or rename whatever holds that name if it is yours — if ` +
                            `that is the resource being replaced itself, delete it by hand — ` +
                            `then re-run the deploy.`) +
                        ` Underlying collision: ${createMsg}`,
                      updateSecrets
                    ),
                    'NAMED_REPLACEMENT_COLLISION',
                    // Chained like the #3808 refusal above: marked, so the
                    // retry classifiers never read the collision text.
                    createError instanceof Error ? createError : undefined
                  )
                );
              }
              if (updateReplacePolicy === 'Retain') {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but its physical name ` +
                    `is still held by the existing resource AND UpdateReplacePolicy: Retain ` +
                    `pins that resource in place. ${nameOrigin.descriptor}. ` +
                    `${nameOrigin.remedy} — with Retain, the old resource keeps the name, so a ` +
                    `same-name replacement can never proceed.`,
                  'NAMED_REPLACEMENT_COLLISION'
                );
              }
              if (this.options.replace !== true) {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but the create-first ` +
                    `attempt collided with the existing resource: ${createMsg}. ` +
                    `${nameOrigin.descriptor}, so the CloudFormation-style safe replacement ` +
                    `order (create the new resource before deleting the old) cannot reuse the ` +
                    `occupied name — CloudFormation refuses this shape with "cannot update a ` +
                    `stack when a custom-named resource requires replacing". ` +
                    `${nameOrigin.remedy}, or re-run with \`cdkd deploy --replace\` to delete ` +
                    `the old resource FIRST and recreate it under the same name (the resource ` +
                    `is briefly unavailable while it is recreated).`,
                  'NAMED_REPLACEMENT_COLLISION'
                );
              }
              // --replace opt-in: the user accepts delete-first semantics
              // (the stateful guard for this property-driven replacement
              // already ran above). Delete the old holder — proven above —
              // then re-create.
              // "named" not "custom-named": the name may be cdkd's own
              // derivation, and this line PRINTS the physical id, so a user
              // reading it against a template that declares no such name was
              // being told it was theirs (issue #1636).
              this.logger.info(
                `  Create-first collided with the existing resource's name and --replace is ` +
                  `set — deleting old ${logicalId} (${currentResource.physicalId}) first...`
              );
              deletedOldFirst = true;
              createResult = await this.replaceDeleteFirstAndRecreate(
                logicalId,
                resourceType,
                oldResourceType,
                currentResource,
                oldDeleteProvider,
                replaceProvider,
                replaceProps,
                updateSecrets,
                updateReplacePolicy
              );
            }

            // Issue #1238: a name-idempotent Create API (e.g. SQS
            // CreateQueue with an unchanged QueueName) does NOT collide
            // when the template carries an explicit physical name — it
            // silently returns the OLD resource's physicalId as the "new"
            // one. The "new" resource IS the old one, so the delete-old
            // step below would destroy the very resource the deploy just
            // reported as created, and state would keep pointing at a
            // deleted resource (observed live with a FIFO queue). Mirror
            // the create-first collision handling above: hard-fail under
            // Retain, fail with the rename / --replace remediation without
            // the opt-in, and fall back to delete-first + re-create under
            // --replace. Skipped when the old resource was already deleted
            // (delete-first fallback) — there, re-acquiring the same
            // physical id under the same name is the expected outcome. Skipped
            // too when `equalIdIsSameResource` is false (issue #2668): across
            // two types an equal id is two resources (custom resources
            // excepted), so the "new" one is NOT the old one and the delete-old
            // step below is aimed — through the OLD type's provider — at the
            // right one.
            if (
              equalIdIsSameResource &&
              !deletedOldFirst &&
              createResult.physicalId === currentResource.physicalId
            ) {
              const idempotentNameOrigin = this.replacementNameOrigin(
                logicalId,
                currentResource.physicalId
              );
              if (updateReplacePolicy === 'Retain') {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
                    `name-idempotent: the create-first attempt returned the existing resource ` +
                    `(${currentResource.physicalId}) instead of creating a new one, and ` +
                    `UpdateReplacePolicy: Retain pins that resource in place. ` +
                    `${idempotentNameOrigin.descriptor}. ${idempotentNameOrigin.remedy} — with ` +
                    `Retain, the old resource keeps the name, so a same-name replacement can ` +
                    `never proceed.`,
                  'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
                );
              }
              if (this.options.replace !== true) {
                throw new CdkdError(
                  `${logicalId} (${resourceType}) requires replacement, but its Create API is ` +
                    `name-idempotent: the create-first attempt returned the EXISTING resource ` +
                    `(${currentResource.physicalId}) instead of creating a new one, so deleting ` +
                    `the "old" resource would silently destroy the resource the deploy just ` +
                    `reported as created. ${idempotentNameOrigin.descriptor}; ` +
                    `${idempotentNameOrigin.remedy}, or re-run with ` +
                    `\`cdkd deploy --replace\` to delete the old resource FIRST and recreate ` +
                    `it under the same name (the resource is briefly unavailable while it is ` +
                    `recreated). Note: this branch is also reached when the old resource was ` +
                    `deleted out-of-band and the physical id is name-derived — there the ` +
                    `create was a genuine fresh create; \`--replace\` converges that case too.`,
                  'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
                );
              }
              // --replace opt-in: same delete-first fallback as the
              // collision path — the "created" resource is the old one, so
              // deleting the old physical id releases the name, and the
              // re-create applies the new properties for real.
              this.logger.info(
                `  Create-first returned the existing resource (name-idempotent Create API) ` +
                  `and --replace is set — deleting old ${logicalId} ` +
                  `(${currentResource.physicalId}) first...`
              );
              deletedOldFirst = true;
              createResult = await this.replaceDeleteFirstAndRecreate(
                logicalId,
                resourceType,
                oldResourceType,
                currentResource,
                oldDeleteProvider,
                replaceProvider,
                replaceProps,
                updateSecrets,
                updateReplacePolicy
              );
            }

            if (deletedOldFirst) {
              // Old resource is already gone (delete-first fallback above).
            } else if (updateReplacePolicy === 'Retain') {
              // Issue #2603: same record as the `--recreate-via-*` arm above —
              // the cleanup delete is skipped, so the rollback must re-adopt
              // rather than re-create.
              this.retainedOldOnReplacement.add(logicalId);
              this.logger.info(
                `  Retaining old ${logicalId} (${currentResource.physicalId}) - UpdateReplacePolicy: Retain`
              );
            } else {
              this.logger.info(`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
              // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
              // old resource before the post-replacement cleanup delete.
              // Two failure classes, deliberately handled differently:
              //   - a REFUSAL (`FINAL_SNAPSHOT_UNSUPPORTED` — cc-api routing
              //     or a type cdkd cannot snapshot) is a CONFIGURATION error
              //     the user must resolve, so it propagates and fails the
              //     resource, matching CloudFormation failing the update.
              //   - a transient snapshot failure / timeout degrades to this
              //     site's existing warn-and-continue policy, but SKIPS the
              //     delete: the old resource stays alive (leaked, warned)
              //     rather than being deleted without its promised snapshot.
              let cleanupFinalSnapshotId: string | undefined;
              let snapshotBlockedDelete = false;
              try {
                cleanupFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
                  logicalId,
                  oldResourceType,
                  currentResource,
                  updateReplacePolicy
                );
              } catch (snapshotError) {
                if (
                  snapshotError instanceof CdkdError &&
                  snapshotError.code === 'FINAL_SNAPSHOT_UNSUPPORTED'
                ) {
                  throw snapshotError;
                }
                snapshotBlockedDelete = true;
                this.logger.warn(
                  `  ⚠ Final snapshot for old ${logicalId} (${currentResource.physicalId}) ` +
                    `failed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}. ` +
                    `The old resource was NOT deleted (UpdateReplacePolicy: Snapshot) — delete it ` +
                    `manually once you have a snapshot; it is no longer tracked in state.`
                );
              }
              if (!snapshotBlockedDelete) {
                await this.deleteReplacedAfterCreate(
                  logicalId,
                  oldResourceType,
                  currentResource,
                  oldDeleteProvider,
                  currentResource.properties,
                  cleanupFinalSnapshotId,
                  updateReplacePolicy,
                  updateSecrets
                );
              }
            }
          }

          // Issue #2274: the replacement path re-CREATES, so the fresh create
          // result carries its own `NoEcho` declaration and must register it —
          // the create arm's registration is in a different `case` and does not
          // run here.
          this.registerNoEchoAttributes(logicalId, createResult, updateSecrets, resolvedProps);

          stateResources[logicalId] = {
            physicalId: createResult.physicalId,
            resourceType,
            properties: this.propertiesToRecord(
              resolvedProps,
              createResult,
              resourceType,
              replaceDecision.provisionedBy
            ),
            ...(createResult.attributes && { attributes: createResult.attributes }),
            ...(dependencies && dependencies.length > 0 && { dependencies }),
            ...this.extractTemplateAttributes(template, logicalId),
            provisionedBy: replaceDecision.provisionedBy,
          };
          this.recordInlinePolicyWrite(logicalId, 'create');

          this.kickOffObservedCapture(
            replaceProvider,
            logicalId,
            createResult.physicalId,
            resourceType,
            resolvedProps,
            { afterOwnWrite: true }
          );

          if (counts) counts.updated++;
          if (progress) progress.current++;
          const replacePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          this.logger.info(
            `${replacePrefix}${yellow('↻')} ${bold(logicalId)} ${gray(`(${resourceType})`)} ${yellow('replaced')}`
          );
        } else {
          // Normal update (in-place).
          //
          // For an existing resource, the layer is sticky: if it was first
          // created via Cloud Control (because of silent-drop properties at
          // CREATE time), the update stays on Cloud Control. If it was
          // SDK-managed and the user has since added a silent-drop property,
          // we re-evaluate via `getProviderFor` — which will auto-route
          // through Cloud Control as long as the user hasn't overridden
          // via `--allow-unsupported-properties`. Once a resource flips
          // to CC mid-life, it stays there (the state record's
          // `provisionedBy: 'cc-api'` written below sticks).
          this.logger.debug(`Updating ${logicalId} (${resourceType})`);
          const updateDecision = this.providerRegistry.getProviderFor({
            resourceType,
            properties: resolvedProps,
            provisionedBy: currentResource.provisionedBy,
            // Issue #2719: the RECORD's bag, not the diff's current side. It is
            // the resolved desired bag of the last successful deploy, so a
            // property applied under Cloud Control and since deleted from the
            // template is still visible here -- which is the one case a
            // desired-only flip condition gets wrong (see
            // `GetProviderForInput.previousProperties`).
            previousProperties: currentResource.properties,
            ...(this.isPinnedToCcApi(stackName, logicalId) && { forceCcApi: true }),
          });
          if (updateDecision.sdkMigration === true) {
            // The ONLY reader of `sdkMigration`, and the reason the field
            // exists: without it this deploy moves a live resource between
            // provisioning layers and says so only at debug level. It fires
            // once, because the record says 'sdk' from this write on.
            //
            // The wording is per MODE, because the two flips happen for
            // opposite reasons and only one of them can be declined. A first
            // revision printed the coverage sentence for both and told a
            // 'cc-broken' user to pass `--pin-cc-api`, which that mode
            // deliberately ignores -- recommending a flag that silently no-ops
            // is the same class of defect as the typo this lane just closed.
            // Exhaustive rather than a ternary: a THIRD mode added later would
            // otherwise inherit the coverage wording AND a `--pin-cc-api`
            // suggestion, which is precisely the wrong-remedy defect this
            // per-mode split exists to fix. `exemptMode` cannot be undefined
            // here — `sdkMigration` is set only after `wouldReturnToSdkProvider`
            // found an entry in this same table — but the default arm keeps
            // that from being load-bearing.
            const exemptMode = STICKY_CC_MIGRATION_EXEMPT.get(resourceType)?.mode;
            const preserved = 'The physical id is preserved';
            let message: string;
            switch (exemptMode) {
              case 'cc-broken':
                message =
                  `${logicalId} (${resourceType}): moving to the SDK provider — Cloud ` +
                  `Control cannot manage this type correctly. ${preserved}, and this ` +
                  `routing is not optional.`;
                break;
              case 'sdk-coverage':
                message =
                  `${logicalId} (${resourceType}): returning to the SDK provider — cdkd now ` +
                  `covers every property this resource uses. ${preserved}; pass ` +
                  `--pin-cc-api ${logicalId} to decline this for a deploy.`;
                break;
              default:
                message = `${logicalId} (${resourceType}): moving to the SDK provider. ${preserved}.`;
            }
            this.logger.info(message);
          }
          const updateProvider = updateDecision.provider;
          const updateProps =
            updateDecision.provisionedBy === 'cc-api'
              ? withoutGeneratedFallbackName(
                  resourceType,
                  resolvedProps,
                  this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
                )
              : resolvedProps;
          // The previous side the provider diffs against, with each create-only
          // path AWS confirmed holding its fresh `NoEcho` value set to the
          // value being sent (go-to-k/cdkd#3729). The record holds `***` there,
          // and a provider comparing `***` with the plaintext would see a
          // create-only change: ACM and IAM ManagedPolicy re-create inside
          // their own `update()` (bypassing `UpdateReplacePolicy: Retain` and
          // the stateful guard), and Cloud Control would patch a create-only
          // path. In memory only: nothing persists this bag, and the provider's
          // masker already holds the value as a needle.
          //
          // And for a type whose provider has no live source for a recorded
          // principal list (IAM::Policy, UserToGroupAddition), an entry state
          // holds as a secret reference the template still spells the same
          // way is dropped from the previous side (go-to-k/cdkd#4064): the
          // record's `{{resolve:...}}` is not a name, so every in-place update
          // was refused, and the desired side names that principal too.
          const { previous: previousForUpdate, dropped: droppedPrincipalKinds } =
            withUnchangedSecretPrincipalLists(
              resourceType,
              currentResource.physicalId,
              noEchoHeldPaths.size === 0
                ? currentPropsAsWritten
                : {
                    ...currentPropsAsWritten,
                    ...Object.fromEntries(
                      [...noEchoHeldPaths]
                        .filter((path) => Object.prototype.hasOwnProperty.call(updateProps, path))
                        .map((path) => [path, updateProps[path]])
                    ),
                  },
              desiredForSkipCheckAsWritten
            );
          if (droppedPrincipalKinds.length > 0) {
            // Kinds only, never names. A secret whose value changed since the
            // last deploy under the same reference is not visible here: the
            // record keeps only the reference.
            const kinds = droppedPrincipalKinds.join(' / ');
            this.logger.warn(
              safeMsg`${logicalId} (${resourceType}): the recorded ${kinds} holds a secret reference the template still spells the same way, so cdkd re-applies it to the principals this deploy resolved it to and removes it from none of them. If that secret's value changed since the last deploy, a principal only the OLD value named still has the policy or membership: remove it from that principal by hand.`
            );
          }

          let result;
          let resultProvisionedBy = updateDecision.provisionedBy;
          // The provider the observed-properties capture below reads the
          // resource back through (issue #2616's neighbour, issue #2608). It
          // moves in LOCKSTEP with `resultProvisionedBy`: both are reassigned
          // together on the update-failure replacement fallback, from the SAME
          // routing decision, so the layer the capture reads and the layer the
          // state record is stamped with cannot disagree by construction.
          //
          // Before this it was hard-wired to `updateProvider` at the call site
          // — the provider that just FAILED the update — so a replacement that
          // re-routed read the NEW physical resource through the OLD layer
          // while state named the new one. The capture then either returned
          // nothing (a provider asked to read a type it does not handle) or a
          // differently-shaped bag than the record's layer implies, and
          // `observedProperties` is what `cdkd drift` and the next deploy's
          // diff compare against — the phantom-drift class of issue #1591.
          //
          // Bound from the decision rather than re-derived with
          // `getProviderFor({ resourceType, provisionedBy: resultProvisionedBy })`:
          // that re-read is NOT an identity for every type. A
          // `STICKY_CC_MIGRATION_EXEMPT` type asked for
          // `provisionedBy: 'cc-api'` can deliberately fall through to its SDK
          // provider. That is the `'cc-broken'` case (`AWS::Scheduler::Schedule`),
          // whose escape is unconditional, so the re-read would reintroduce
          // exactly the mismatch it was meant to close.
          //
          // NOT the `'sdk-coverage'` case, despite the symmetry: this re-read
          // passes NO property bags, and that mode's flip requires both of
          // them, so it would refuse. An earlier revision of this comment said
          // the opposite and contradicted its own sibling at the
          // observed-capture site, which relies on that same no-bags refusal. The property-driven replacement
          // twin above passes `replaceProvider` for the same reason.
          let captureProvider = updateProvider;
          const inlinePolicyClaimed = this.inlinePolicyClaimedFor(
            resourceType,
            logicalId,
            stateResources
          );
          try {
            result = await this.withRetry(
              () =>
                // The UPDATE twin of the CREATE call's async-local scope (issue
                // #1903). Both paths bind it or a nested stack that already
                // exists silently keeps persisting the parent's plaintext.
                withCurrentResourceSecrets(updateSecrets, () =>
                  updateProvider.update(
                    logicalId,
                    currentResource.physicalId,
                    resourceType,
                    updateProps,
                    // `currentPropsAsWritten` (issue #2750): the ONE consumer
                    // of the previous side that is asking what AWS holds.
                    // `CloudControlProvider.update` diffs this into a JSON
                    // Patch, so a key the SDK route never wrote must be absent
                    // here or the patch omits it and the auto-route sends
                    // nothing for it. `previousForUpdate` differs from it only
                    // at confirmed NoEcho paths (go-to-k/cdkd#3729), and at an
                    // IAM::Policy / UserToGroupAddition principal list whose
                    // unchanged secret reference was dropped (go-to-k/cdkd#4064).
                    previousForUpdate,
                    // The UPDATE twin of the CREATE call's masker (issue #1932
                    // item 3): same resolved bag, same exposure, so the contract
                    // is applied on both or it has a hole in the shape of
                    // whichever path a given deploy takes.
                    //
                    // `expectedRegion` (issue #2301 item 1) is the same value
                    // this file already hands every `DeleteContext` it builds:
                    // the region this stack's state was read under and is
                    // written back to. The update is addressed BY
                    // `currentResource.physicalId`, a state-recorded id, so it
                    // carries the same wrong-region hazard the delete sites do
                    // -- misapplied configuration rather than destruction, but
                    // on a resource cdkd does not manage. Typed `string`, so a
                    // caller with no region hands over `''`; the guard treats
                    // that as absent and proceeds.
                    //
                    // `recordedAttributes` (issue #4051): the identity evidence
                    // of the record `currentResource.physicalId` came from.
                    {
                      maskSecrets: createSecretMasker(updateSecrets),
                      expectedRegion: this.stackRegion,
                      recordedAttributes: currentResource.attributes,
                      ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
                    }
                  )
                ),
              logicalId,
              undefined,
              undefined,
              updateProvider
            );
          } catch (updateError) {
            // If UPDATE is not supported, fall back to a replacement. Two
            // triggers:
            //   1. CC API `UnsupportedActionException` — auto-fallback, needs
            //      no flag to REACH the replacement (issue #2514 left that
            //      half unchanged; only the stateful guard below became common
            //      to both triggers).
            //   2. An SDK provider throwing a typed
            //      `ResourceUpdateNotSupportedError` (an immutable property
            //      changed on a type with no replacement rule) — gated on the
            //      user opting in via `--replace`, because for some of these
            //      types the replacement is a data-losing DELETE + CREATE.
            //
            // Trigger 1 is classified STRUCTURALLY since issue #2520:
            // `isUpdateUnsupportedError` walks the bounded cause chain for the
            // exception NAME (and the async `ccErrorCode`), because the
            // provider's wrapper never copies the name into its message — the
            // predicate's old `includes('UnsupportedActionException')` half
            // therefore matched nothing cdkd produces. AWS's prose is not read
            // at all (issue #3810): a message can quote template-chosen text.
            //
            // `logicalId` is passed because a chain walk is otherwise WIDER
            // than the message read it replaces: a nested stack's child deploy
            // runs inside THIS `provider.update()` call, so a child resource's
            // Cloud Control rejection is reachable down the parent's cause
            // chain — and reading it here would DELETE + CREATE the whole
            // child stack. The classifier's doc comment carries that, the
            // measured wire shape, and the codes it deliberately refuses.
            const ccUnsupported = isUpdateUnsupportedError(updateError, logicalId);
            const typedUnsupported = updateError instanceof ResourceUpdateNotSupportedError;
            const replaceOptIn = typedUnsupported && this.options.replace === true;
            if (ccUnsupported || replaceOptIn) {
              // `UpdateReplacePolicy: Retain` on the fallback replacement
              // (issue #2518). Until this landed, the fallback deleted the old
              // resource whatever the policy said, while every OTHER
              // replacement path in this engine honoured `Retain`: the
              // property-driven cleanup below logs "Retaining old ...", the
              // `--recreate-via-*` path warns and leaks it, and both
              // delete-first fallbacks refuse the replacement outright. The
              // same template attribute therefore decided retention on one
              // path and nothing on the other, so a resource the user
              // explicitly marked to survive its replacement was destroyed —
              // and for a stateful type, its data with it.
              //
              // Two things made honouring it the right arm rather than
              // refusing the replacement outright:
              //   - It is what the SIBLING path already does. A refusal here
              //     would have swapped one internal divergence (retain there,
              //     delete here) for another (retain there, refuse here), and
              //     CloudFormation itself retains on replacement.
              //   - `rollback-executor.ts`'s replacement rollback ALREADY
              //     assumes it: an op classified `reverse-replacement-readopt`
              //     deletes the new resource and points state back at the old
              //     physical id WITHOUT re-creating it. With the old resource
              //     deleted, that rollback re-adopted a dead id. (That verdict
              //     was read off `previousState.updateReplacePolicy` until
              //     issue #2603 moved it onto the record this path now writes
              //     — see `retainedOldOnReplacement`, set on the arm below.)
              //
              // So under `Retain` this path becomes create-ONLY: the old
              // resource is left in place (orphaned, exactly as the
              // property-driven path leaves it) and only the replacement
              // create runs. `Retain` and `Snapshot` are alternative values of
              // one attribute, so nothing is skipped by not preparing a final
              // snapshot on this arm.
              //
              // The order flip is safe in the same direction as the
              // property-driven path's: creating first keeps the old resource
              // alive if the create fails. What it CANNOT do is reuse a
              // physical name the retained resource still holds, so both
              // shapes that follow from that are refused LOUDLY below with the
              // same error codes the property-driven path already uses.
              //
              // TEMPLATE ONLY, via the shared `updateReplacePolicy` binding —
              // the same read the property-driven guard's exemption uses, so
              // the two ask "what is the user applying NOW?" of one value.
              // Only `'Retain'` is honoured: `RetainExceptOnCreate` is a
              // `DeletionPolicy` value CloudFormation rejects for
              // `UpdateReplacePolicy`, so it cannot reach here.
              const retainOldOnReplace = updateReplacePolicy === 'Retain';
              // Stateful guard for BOTH triggers (issue #2514). A stateful
              // type (RDS / DynamoDB / EFS / etc.) must not be silently
              // DELETE+CREATEd — require --force-stateful-recreation.
              //
              // It used to sit inside `if (replaceOptIn)`, so the CC
              // auto-fallback recreated a stateful resource on a plain
              // `cdkd deploy` with neither `--replace` nor
              // `--force-stateful-recreation`, while the SAME type behind an
              // SDK provider was refused twice over. The discriminator was
              // neither the resource nor the user's intent but which
              // provisioning layer the type happened to route through — and
              // routing is re-decided every deploy (`provisionedBy` is
              // recorded, not pinned), so the guard's presence was not
              // something a user could reason about. The delete below is
              // identical on both triggers, so the data-loss consent belongs
              // to the REPLACEMENT, not to the trigger.
              //
              // Conservative variant: this fires mid-deploy with no chance to
              // run either async emptiness probe, so a deferred S3 bucket — and
              // likewise a log group with no recorded retention, CloudWatch
              // Logs' never-expire (issue #2558) — is treated as stateful
              // (block unless forced).
              //
              // `UpdateReplacePolicy: Retain` IS an exemption here since issue
              // #2518, exactly as it is on the property-driven replacement
              // guard above and for the same reason: the old resource and its
              // data survive the replacement (orphaned, not deleted), so there
              // is no data loss for `--force-stateful-recreation` to confirm.
              // Demanding the consent flag for a replacement that destroys
              // nothing would be a refusal whose only remedy is a flag that
              // means "yes, lose the data" — advice that was actively wrong
              // for the one user who had already asked to keep it.
              //
              // `Snapshot` stays NON-exempt on both paths: cdkd does take the
              // final snapshot, but a snapshot is a point-in-time copy, not a
              // surviving resource.
              const statefulReason = retainOldOnReplace
                ? null
                : isStatefulRecreateTargetForReplace(
                    resourceType,
                    currentProps,
                    // The observed bag, for the same reason the property-driven
                    // guard above passes it (issue [#2521]).
                    currentResource.observedProperties
                  );
              if (statefulReason && this.options.forceStatefulRecreation !== true) {
                // No `Retain` note here any more (issue #2518): reaching this
                // throw MEANS the template is not applying `Retain`, because
                // `retainOldOnReplace` short-circuits `statefulReason` to
                // `null` above. The note this replaced said "Retain does NOT
                // protect this path", which is now false — and it was advice
                // whose remedy (`--force-stateful-recreation`) deleted the very
                // resource the user had asked to keep.
                //
                // The `Retain` read stays TEMPLATE ONLY — deliberately no
                // `?? currentResource.updateReplacePolicy` fallback, which is
                // where the snapshot attribute a few lines below DOES fall
                // back to state. The two decisions are not the same shape:
                // omitting a promised snapshot is destructive, so that read is
                // conservative, while this one describes the attribute the user
                // is applying NOW. Falling back to state would retain a
                // resource on the strength of a policy the template being
                // applied has since dropped.
                //
                // Hence the shared `updateReplacePolicy` binding, read once in
                // this UPDATE branch's own scope: it IS the template-only read,
                // so the property-driven guard's exemption and this path's ask
                // the same question of the same value, and a future change to
                // one cannot leave the other on an older spelling. The snapshot
                // read below is the deliberate exception and stays spelled out
                // with its state fallback.
                //
                // `markNonRetryable` for the same reason as the property-driven
                // guard's twin above: a flag plus a state-recorded bag decide
                // it, and the message carries a template-controlled logical id
                // into substring-matching classifiers.
                throw markNonRetryable(
                  new CdkdError(
                    replaceOptIn
                      ? `--replace would DELETE + CREATE the stateful resource ${logicalId} ` +
                          `(${resourceType}) — ${renderStatefulReason(statefulReason)}. Re-run with ` +
                          `--force-stateful-recreation to confirm the data loss, or change the ` +
                          `resource definition to avoid the immutable-property change.`
                      : `${logicalId} (${resourceType}) cannot be updated in place by the ` +
                          `provisioning layer it routes through, so applying this change would ` +
                          `DELETE + CREATE it — but it is a stateful resource: ` +
                          `${renderStatefulReason(statefulReason)}. Re-run with ` +
                          `--force-stateful-recreation to confirm the data loss, or change the ` +
                          `resource definition to avoid the update.`,
                    'STATEFUL_REPLACE_BLOCKED',
                    // Chain the rejection that routed us here: the message
                    // above names no layer and no AWS text, so this is the
                    // only place that rejection is retained.
                    //
                    // Where it actually SURFACES is narrower than the terminal
                    // output: `formatError` (`src/utils/error-handler.ts`)
                    // renders exactly ONE `Caused by:` level, and the error the
                    // CLI prints is the `ProvisioningError` this method's catch
                    // wraps the refusal in — so that one level is the refusal's
                    // own message and the raw Cloud Control text stays a hop
                    // below it, unprinted. It DOES reach the persisted
                    // `RESOURCE_FAILED` event: `extractDeploymentEventError`
                    // walks the whole chain for `awsErrorCode` / `requestId`,
                    // so `cdkd events` can name the AWS rejection behind the
                    // refusal (pinned in `tests/unit/types/deployment-events.test.ts`).
                    //
                    // Safe to chain now that the refusal is marked:
                    // `isMarkedNonRetryable` is consulted before any chain-text
                    // classification, and `ccUnsupported` reads only the
                    // exception NAME and `ccErrorCode` down the chain, never a
                    // message (issue #3810).
                    updateError instanceof Error ? updateError : undefined
                  )
                );
              }
              // The replacement create gets a fresh routing decision, against
              // the record as its unrecognized-property baseline (issue #3713,
              // same reason as `replaceDecision`). Taken before anything is
              // deleted, since the name check below needs its route.
              const replDecision = this.providerRegistry.getProviderFor({
                resourceType,
                properties: resolvedProps,
                previousProperties: currentResource.properties,
              });
              const replProvider = replDecision.provider;
              const replProps =
                replDecision.provisionedBy === 'cc-api'
                  ? this.preparePropertiesForCcApi(resourceType, resolvedProps, logicalId)
                  : resolvedProps;
              // go-to-k/cdkd#3937 / #3931, as on the property-driven path: a
              // name known to move off the old resource's, probed where the
              // create would adopt a taken one. Under Retain it only probes.
              const fallbackNameChange = await this.checkedReplacementNameChange({
                logicalId,
                resourceType,
                oldResourceType: resourceType,
                stackName,
                currentResource,
                desiredProperties: resolvedProps,
                createProvider: replProvider,
                createdVia: replDecision.provisionedBy,
                createProps: replProps,
                secrets: updateSecrets,
              });
              const createFirst = !retainOldOnReplace && fallbackNameChange !== undefined;
              this.logger.info(
                retainOldOnReplace
                  ? `UPDATE not supported for ${logicalId} (${resourceType}), replacing ` +
                      `(CREATE only — UpdateReplacePolicy: Retain keeps the old resource)`
                  : createFirst
                    ? safeMsg`UPDATE not supported for ${logicalId} (${resourceType}), replacing (CREATE → DELETE — the new name differs from the old resource's)`
                    : `UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`
              );
              if (!retainOldOnReplace && !createFirst) {
                // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the
                // old resource before the fallback replacement's delete. The
                // TEMPLATE is authoritative here — unlike a destroy, an update
                // necessarily has the resource in the template, and the
                // attribute being applied is the desired one (state records
                // only what the LAST deploy used, so a template that just
                // gained `Snapshot` must not be overridden by a stale
                // `Delete`). State is the fallback for a template that omits
                // the attribute, and this is the ONLY snapshot read on the
                // replacement paths that has one: every other site above passes
                // the shared `updateReplacePolicy` binding, which is template-only.
                // The divergence is deliberate — omitting a promised snapshot is
                // destructive, so this read is conservative, while the `Retain`
                // decision above only describes what the user is applying now.
                //
                // Unreachable under `Retain` (issue #2518) and not merely
                // skipped: `UpdateReplacePolicy` is ONE attribute, so a
                // template applying `Retain` is not applying `Snapshot`, and
                // the state fallback cannot reintroduce it — `??` only fires
                // when the template omits the attribute entirely, which is
                // exactly when `retainOldOnReplace` is false.
                const fallbackUpdateReplacePolicy =
                  template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
                  currentResource.updateReplacePolicy;
                const fallbackFinalSnapshotId = await this.prepareFinalSnapshotForDelete(
                  logicalId,
                  resourceType,
                  currentResource,
                  fallbackUpdateReplacePolicy
                );
                // Initialized because the catch below can leave it unassigned.
                let fallbackDeleteResult: void | ResourceDeleteResult = undefined;
                try {
                  fallbackDeleteResult = await updateProvider.delete(
                    logicalId,
                    currentResource.physicalId,
                    resourceType,
                    currentProps,
                    {
                      expectedRegion: this.stackRegion,
                      forceDataDelete: this.options.forceStatefulRecreation === true,
                      ...(fallbackFinalSnapshotId !== undefined && {
                        finalSnapshotIdentifier: fallbackFinalSnapshotId,
                      }),
                      ...this.replacementDeleteContext(fallbackUpdateReplacePolicy),
                      recordedAttributes: currentResource.attributes,
                    }
                  );
                } catch (deleteError) {
                  // If old resource doesn't exist (already deleted), proceed with CREATE
                  const deleteMsg =
                    deleteError instanceof Error ? deleteError.message : String(deleteError);
                  // Typed check FIRST, and this arm is the worst of the four
                  // already-deleted classifiers to get wrong (issue
                  // go-to-k/cdkd#3236): reading "already gone" here does not
                  // merely drop a state row, it proceeds to CREATE the
                  // replacement BESIDE an old resource whose delete may still
                  // be running. A `CloudControlWaitAbandonedError` says
                  // exactly that — cdkd stopped watching an operation still in
                  // flight — and its message interpolates the LOGICAL ID, so a
                  // construct named `PageNotFound` satisfies the bare
                  // `NotFound` needle below. The substring match cannot be
                  // made safe; any needle can appear in a user-chosen name.
                  //
                  // This arm carried NO typed guard at all, unlike its two
                  // siblings — so `isInterruptedWaitError` and
                  // `isMarkedNonRetryable` join it here for the same reasons
                  // those siblings state.
                  if (
                    !isWaitAbandonedError(deleteError) &&
                    !isInterruptedWaitError(deleteError) &&
                    !isMarkedNonRetryable(deleteError) &&
                    (deleteMsg.includes('does not exist') ||
                      deleteMsg.includes('not found') ||
                      deleteMsg.includes('NotFound'))
                  ) {
                    this.logger.debug(
                      `Old resource ${logicalId} already gone, proceeding with CREATE`
                    );
                  } else {
                    throw deleteError;
                  }
                }
                // Issue #1762: a skip fails the resource here too — the CREATE
                // below re-provisions the resource, so proceeding would leave
                // the old one alive and untracked. Deliberately OUTSIDE the
                // catch: the classifier above reads "already gone" out of an
                // error MESSAGE, and a skip must never be read that way.
                const fallbackSkipReason = deleteSkipReason(fallbackDeleteResult);
                if (fallbackSkipReason !== undefined) {
                  throw new Error(
                    deleteSkippedMessage(
                      logicalId,
                      currentResource.physicalId,
                      fallbackSkipReason,
                      'during the UPDATE-not-supported replacement'
                    )
                  );
                }
              }
              // Set only on the retain arm; drives the `partial` outcome below.
              let retainedSurvivorReason: string | undefined;
              let createResult: ResourceCreateResult;
              try {
                createResult =
                  createFirst && fallbackNameChange !== undefined
                    ? await this.createFirstThenDeleteOld({
                        logicalId,
                        resourceType,
                        oldResourceType: resourceType,
                        currentResource,
                        createProvider: replProvider,
                        createProps: replProps,
                        deleteProvider: updateProvider,
                        deleteProperties: currentProps,
                        secrets: updateSecrets,
                        change: fallbackNameChange,
                        equalIdIsSameResource: !equalIdNamesDifferentResources({
                          resourceType,
                          physicalId: currentResource.physicalId,
                          oldProperties: currentResource.properties,
                          newProperties: resolvedProps,
                        }),
                        // The same state fallback as the DELETE → CREATE arm's
                        // snapshot read, for the same reason.
                        snapshotPolicy:
                          template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
                          currentResource.updateReplacePolicy,
                        deletePolicy:
                          template?.Resources?.[logicalId]?.UpdateReplacePolicy ??
                          currentResource.updateReplacePolicy,
                        trigger: 'the provisioning layer cannot update it in place',
                      })
                    : await this.withRetry(
                        () =>
                          withCurrentResourceSecrets(updateSecrets, () =>
                            replProvider.create(logicalId, resourceType, replProps, {
                              maskSecrets: createSecretMasker(updateSecrets),
                            })
                          ),
                        logicalId,
                        undefined,
                        undefined,
                        replProvider
                      );
              } catch (createError) {
                // The create-first arm's errors are already its own, and the
                // old resource is untouched there.
                if (createFirst) throw createError;
                // Only `Retain` turned this into a create-FIRST path, so only
                // `Retain` owes the name-collision translation (issue #2518).
                // Without it the user reads a raw `AlreadyExists` and has no
                // way to connect it to the policy that caused it.
                if (!retainOldOnReplace) {
                  // ...but the NON-Retain arm owes the other half (issue
                  // #2616): it is the DELETE → CREATE order, so by the time
                  // this runs the old resource is GONE. Two sub-paths reach
                  // here and the wording covers both: the delete above
                  // succeeded, OR it rejected with a not-found the block's
                  // classifier read as "already gone" — where something ELSE
                  // removed the resource. So the sentence names NO actor: it
                  // states only that the resource is gone, which is true on
                  // both sub-paths and is the fact the user needs. Two review
                  // rounds landed here — "already deleted the old resource"
                  // and then "replacement removed the old resource" both keep
                  // the replacement as the subject of the removal, which the
                  // second sub-path falsifies. Handing back the
                  // provider's raw create error leaves the user unable to tell
                  // "the replacement never started" from "the replacement
                  // destroyed the old resource and then failed" — which is
                  // exactly what decides whether a re-run is safe and whether
                  // anything downstream is now dangling. `--replace`'s
                  // delete-first fallback ({@link replaceDeleteFirstAndRecreate})
                  // wraps the identical situation, so this is the same
                  // contract, not a new one -- but NOT the same sentence, and
                  // the difference is deliberate: that sibling still says
                  // "already deleted the old resource", which is correct
                  // THERE because its delete catch rethrows unconditionally,
                  // so the only way past it is a delete that succeeded. This
                  // arm has an "already gone" classifier, so it cannot name an
                  // actor (see below).
                  //
                  // Issue #2038: masked at construction, for the same reason as
                  // that sibling — the create was handed the RESOLVED
                  // `replProps`, so the AWS message this echoes can carry a
                  // substituted secret.
                  //
                  // CHAINED, unlike that sibling: the arm this replaces
                  // rethrew `createError` itself, so its `$metadata` /
                  // `Code` reached `extractDeploymentEventError` and the
                  // persisted `RESOURCE_FAILED` event named the AWS rejection.
                  // Wrapping without a `cause` would have silently traded that
                  // for the sentence. Safe to chain here: nothing between this
                  // throw and the DAG executor re-classifies it — the retry
                  // lives INSIDE `this.withRetry` above, which has already
                  // given up — so no substring classifier reads the cause's
                  // text (contrast the `Retain` arm below, which needs
                  // `markNonRetryable` because its refusal quotes name-cooldown
                  // spellings the retry loop WOULD act on).
                  //
                  // Chained UNMASKED, unlike the rollback executor's twin which
                  // wraps its cause in `maskSecretsInError` -- a deliberate
                  // asymmetry, recorded because three separate review passes
                  // raised it. This throw is inside `provisionResourceBody`;
                  // one frame up, `provisionResource`'s catch re-wraps it with
                  // `maskSecretsInError` over the cause CHAIN, so every link
                  // the walk reaches is masked before anything leaves that
                  // method (bounded — see `maskSecretsInError`'s own contract
                  // for the depth cap and its non-`Error` carve-out; this
                  // chain is 3 deep). The rollback executor has no such
                  // boundary — `replaySingle`'s catch masks TEXT and swallows —
                  // which is why its sites mask per site. The MESSAGE is still
                  // masked at construction here, which is what issue #2616
                  // requires.
                  throw new Error(
                    maskSecretsInText(
                      `Failed to create ${logicalId} after the UPDATE-not-supported ` +
                        `replacement: the old resource (${currentResource.physicalId}) ` +
                        `is now gone. Cause: ` +
                        `${createError instanceof Error ? createError.message : String(createError)}. ` +
                        `Re-run the deploy to create it fresh.`,
                      updateSecrets
                    ),
                    { cause: createError instanceof Error ? createError : undefined }
                  );
                }
                // Same HEURISTIC, and the same bounded blast radius, as
                // the property-driven create-first path's: a false positive
                // only rewrites the error text — nothing destructive follows
                // either branch here, because this arm never deletes.
                if (!isNameCollisionErrorFrom(createError, logicalId)) throw createError;
                // Issue #3808, as on the property-driven path: when the
                // template's explicit name is not the one the retained resource
                // holds, "remove Retain so cdkd deletes the old resource first"
                // would destroy it and still collide.
                const nameHeldElsewhere = replacementRequestsDifferentName({
                  oldResourceType: resourceType,
                  newResourceType: resourceType,
                  desiredProperties: resolvedProps,
                  recorded: currentResource.properties,
                  observed: currentResource.observedProperties,
                  physicalId: currentResource.physicalId,
                });
                if (nameHeldElsewhere !== undefined) {
                  throw markNonRetryable(
                    new CdkdError(
                      `${logicalId} (${resourceType}) requires replacement because the ` +
                        `provisioning layer cannot update it in place, but the create collided. ` +
                        `${renderNameHeldElsewhere(nameHeldElsewhere)} — so removing ` +
                        `UpdateReplacePolicy: Retain would delete this resource and still ` +
                        `collide. Choose a name no other resource holds, or delete the resource ` +
                        `holding it if it is yours.`,
                      'NAMED_REPLACEMENT_COLLISION',
                      createError instanceof Error ? createError : undefined
                    )
                  );
                }
                const nameOrigin = this.replacementNameOrigin(
                  logicalId,
                  currentResource.physicalId
                );
                // Verbatim the property-driven twin's verdict and code: with
                // Retain the old resource keeps the name, so a same-name
                // replacement can never proceed — under ANY flag, since the
                // only escape hatches (`--replace`, `--force-stateful-
                // recreation`) both work by deleting the resource Retain
                // pins in place.
                //
                // `markNonRetryable` for the same reason as the stateful
                // guard's refusal above: a template attribute and a physical
                // name decide it, neither of which a retry can change, and the
                // message interpolates a template-controlled logical id — plus
                // the name-collision text of its own `cause` — into exactly
                // what the SUBSTRING-matching retry classifiers read. Chaining
                // the create rejection is what makes the refusal diagnosable
                // (`extractDeploymentEventError` walks the chain for
                // `awsErrorCode`), and it is safe only BECAUSE of the marker:
                // `isNameCooldownError`'s spellings are retryable, so an
                // unmarked refusal carrying one would burn the full 64s
                // schedule on a path that cannot succeed.
                throw markNonRetryable(
                  new CdkdError(
                    `${logicalId} (${resourceType}) requires replacement because the ` +
                      `provisioning layer cannot update it in place — but its physical name ` +
                      `is still held by the existing resource AND ` +
                      `UpdateReplacePolicy: Retain pins that resource in place. ` +
                      `${nameOrigin.descriptor}. ${nameOrigin.remedy} — with Retain, the old ` +
                      `resource keeps the name, so a same-name replacement can never proceed. ` +
                      `Removing UpdateReplacePolicy: Retain lets cdkd delete the old resource ` +
                      `first, which destroys it and any data it holds.`,
                    'NAMED_REPLACEMENT_COLLISION',
                    createError instanceof Error ? createError : undefined
                  )
                );
              }
              if (retainOldOnReplace) {
                // Issue #1238's shape, on this path: a name-idempotent Create
                // API (e.g. SQS `CreateQueue` with an unchanged `QueueName`)
                // returns the EXISTING resource instead of colliding. With the
                // old resource retained, recording that id as the "new" one
                // would re-adopt the very resource Retain just orphaned —
                // without the new properties ever being applied — so fail
                // before any state bookkeeping runs. The property-driven twin
                // makes the same call with the same code.
                if (
                  createResult.physicalId === currentResource.physicalId &&
                  // Issue #3892: an equal id can still be a NEW table (Glue).
                  !equalIdNamesDifferentResources({
                    resourceType,
                    physicalId: currentResource.physicalId,
                    oldProperties: currentResource.properties,
                    newProperties: resolvedProps,
                  })
                ) {
                  const idempotentNameOrigin = this.replacementNameOrigin(
                    logicalId,
                    currentResource.physicalId
                  );
                  // Marked for the same reason as its collision sibling: the
                  // verdict is two recorded physical ids plus a template
                  // attribute, and the message carries template-controlled
                  // text into the substring classifiers. Nothing to chain —
                  // the create SUCCEEDED; the failure is what it returned.
                  throw markNonRetryable(
                    new CdkdError(
                      `${logicalId} (${resourceType}) requires replacement, but its Create ` +
                        `API is name-idempotent: the create returned the existing resource ` +
                        `(${currentResource.physicalId}) instead of creating a new one, and ` +
                        `UpdateReplacePolicy: Retain pins that resource in place, so the new ` +
                        `properties were not applied. ${idempotentNameOrigin.descriptor}. ` +
                        `${idempotentNameOrigin.remedy} — with Retain, the old resource keeps ` +
                        `the name, so a same-name replacement can never proceed.`,
                      'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
                    )
                  );
                }
                // Issue #2603: the third and last engine path that leaves the
                // old physical resource alive on a replacement. Recorded AFTER
                // the idempotent-create refusal above, which throws — a
                // resource that fails never reaches `completedOperations`, so
                // the placement is belt-and-braces rather than load-bearing.
                this.retainedOldOnReplacement.add(logicalId);
                // WARN, not info, and louder than the line the property-driven
                // cleanup prints. The two arms leak identically, but they are
                // reached on completely different terms: the property-driven
                // one requires the user to have changed an immutable property,
                // which `cdkd diff` shows them beforehand, while THIS arm
                // fires on `ccUnsupported` ALONE — no flag, no diff signal,
                // nothing the user did on purpose. A plain `cdkd deploy` that
                // changes an ordinary property on a `Retain`-declaring cluster
                // now creates a SECOND cluster and leaves the first running,
                // where before this PR it hard-refused with
                // STATEFUL_REPLACE_BLOCKED. Same `⚠` shape as the
                // `--recreate-via-*` leak warning above, which announces the
                // strictly LESS surprising version of this outcome.
                this.logger.warn(
                  `  ⚠ ${logicalId} has UpdateReplacePolicy: Retain — the old physical ` +
                    `resource (${currentResource.physicalId}) is RETAINED and is no longer ` +
                    `tracked by cdkd: it keeps running and incurring cost, and ` +
                    `\`cdkd destroy\` will not remove it. Delete it yourself once you no ` +
                    `longer need its data.`
                );
                // ...and declare it through the channel that survives the
                // terminal (issue #1819). `updatePartial`'s contract is
                // literally this shape — "updated, but something the update
                // owned survives untracked" — so the row prints
                // `partial (<reason>)` instead of `updated`, the run summary
                // counts it under "of which left an orphaned predecessor", and
                // a `RESOURCE_SKIPPED` event lands in the durable store
                // carrying the SURVIVOR's physical id and routing layer, which
                // is the one datum a cleanup pass needs.
                //
                // TWO consequences, stated because neither is cosmetic:
                //   - a TOP-LEVEL stack's deploy EXITS 2
                //     (`--allow-unaddressed` opts out), the same code
                //     `cdkd destroy` returns for a skipped delete. Correct
                //     here and arguably more so: a skipped delete self-heals
                //     on the next run, while this survivor is untracked, so
                //     nothing will ever retry it.
                //     SCOPED to top-level deliberately — inside a NESTED
                //     stack it is false today, and this arm is what turns
                //     that from an internal detail into a stated contract.
                //     `NestedStackProvider.runChildDeploy` is `Promise<void>`
                //     and DISCARDS the child engine's `DeployResult`, and its
                //     `update()` returns no `outcome`, so a child's
                //     `updatePartial` never reaches the parent's counter:
                //     the child logs the warn and the `partial (...)` row from
                //     its own logger while the run still exits 0 over a live
                //     untracked resource. Pre-existing and filed as issue
                //     [#1989](https://github.com/go-to-k/cdkd/issues/1989),
                //     which this arm is folded into as a row; rolling the
                //     child counts up is a behaviour change to a path this
                //     change does not touch.
                //   - it makes this arm LOUDER than the property-driven twin,
                //     which retains with only an info line. Deliberate, on the
                //     trigger asymmetry above, and recorded rather than
                //     silently unified — bringing the twin along is a
                //     behaviour change to a path this PR does not otherwise
                //     touch.
                retainedSurvivorReason =
                  `UpdateReplacePolicy: Retain kept the old ${resourceType} ` +
                  `(${currentResource.physicalId}), now untracked by cdkd`;
              }
              // Annotated rather than inferred: `result` is an evolving `let`,
              // and a conditional spread makes the literal's type a union that
              // TS then checks against the wrong constituent.
              const replacementResult: ResourceUpdateResult = {
                physicalId: createResult.physicalId,
                wasReplaced: true,
                // Spread rather than assigned: under `exactOptionalPropertyTypes`
                // an explicit `undefined` is not assignable to an optional
                // property. Behaviorally identical — the reader below is
                // `result.attributes ?? ...`, which cannot tell absent from
                // undefined.
                ...(createResult.attributes && { attributes: createResult.attributes }),
                // The create's own `NoEcho` declaration, carried for the same
                // reason the property-driven twin passes `createResult` whole:
                // this literal REPLACES the update result, so a declaration
                // dropped here never reaches `registerNoEchoAttributes` below
                // and the replacement's sensitive attributes land UNMASKED in
                // `state.json`. Found by review on this PR; the omission
                // pre-dates it, but `Retain` makes this block the only thing
                // that runs on the path, so leaving it would ship a literal
                // known to be wrong in the hunk being rewritten.
                ...(createResult.noEchoAttributes === true && { noEchoAttributes: true }),
                ...(createResult.noEchoAttributeNames && {
                  noEchoAttributeNames: createResult.noEchoAttributeNames,
                }),
                // The `'partial'` arm of the outcome union, set only when the
                // retain branch above ran. A ternary rather than a conditional
                // spread: `ResourceUpdateResult` intersects a DISCRIMINATED
                // union, and spreading `outcome`/`reason` conditionally makes
                // the literal's type a union TS then checks against the wrong
                // constituent — the same trap the annotation above exists for.
                ...(retainedSurvivorReason !== undefined
                  ? ({ outcome: 'partial', reason: retainedSurvivorReason } as const)
                  : ({ outcome: 'updated' } as const)),
              };
              // Carried explicitly: this literal REPLACES the update result, so
              // a narrowing the replacement create announced would be dropped
              // on the floor and the desired bag recorded instead — silently
              // re-introducing the phantom drift (#1591).
              if (createResult.effectiveProperties) {
                replacementResult.effectiveProperties = createResult.effectiveProperties;
              }
              result = replacementResult;
              resultProvisionedBy = replDecision.provisionedBy;
              // Issue #2608: same decision, same statement — the two must not
              // be separable by a later edit.
              captureProvider = replProvider;
            } else {
              throw updateError;
            }
          }

          if (result.wasReplaced) {
            this.logger.info(
              `Resource ${logicalId} was replaced: ${currentResource.physicalId} -> ${result.physicalId}`
            );
          }

          // Issue #3462 — the ONE refusal class an in-place UPDATE may not
          // clear. The rebuild below enumerates its fields, which is what
          // clears every other `observedBaselineRefused` (see
          // `drainObservedCaptures`); for an unverifiable-parameter refusal
          // that is the leak. `cdkd import` refused because a template
          // parameter was not provably deployed at its `Default`, and a
          // top-level deploy binds that SAME `Default` (a nested child is handed
          // its values by the parent, where keeping the refusal is merely
          // conservative): the record's placeholder leaf is unchanged, so the
          // provider need not have rewritten it, AWS can still hold the
          // deployed value there, and a readback positioned against the
          // placeholder pairs it as an ordinary drifted literal. The engine
          // cannot know which leaves a provider wrote, so NO in-place update
          // discharges it, whatever it changed.
          //
          // A replacement does, but only one that is EVIDENCED: `wasReplaced`
          // AND a physical id that actually changed, so the capture below reads
          // a resource built from the bag cdkd sent. The flag alone is not
          // trusted: `S3BucketProvider.update` answers `wasReplaced: true` with
          // the OLD id when the bound `BucketName` differs from it — exactly
          // this class's shape, a name bound to a placeholder — having created
          // nothing, and the capture would then read the old bucket. Both
          // half-signals (the flag with the same id, a new id without the
          // flag, the update-unsupported fallback re-creating under the same
          // name) KEEP the refusal: the fail-closed reading.
          //
          // A marker an older cdkd recorded WITHOUT a reason reaches this line
          // already read: `stampReasonlessParameterRefusals` ran at deploy
          // start (issue #3468).
          const dischargedByReplacement =
            result.wasReplaced === true && result.physicalId !== currentResource.physicalId;
          const keepsParameterRefusal =
            !dischargedByReplacement && hasUnverifiableParameterRefusal(currentResource);

          // Attributes: prefer the update result's fresh set; when the
          // provider returned none AND the resource was updated IN PLACE,
          // carry the previously-stored (create-time) attributes forward —
          // an in-place update never invalidates them, and dropping them
          // would degrade every later Fn::GetAtt on this resource to the
          // physical-id fallback (observed live: an FSx update wiped
          // LustreMountName / DNSName and the stack outputs regressed to
          // the file-system id). A REPLACED resource must NOT inherit the
          // old resource's attributes — its create result is authoritative
          // (and absent attributes stay absent).
          const carriedAttributes =
            result.attributes ?? (result.wasReplaced ? undefined : currentResource.attributes);

          // Issue #2274: registered against `carriedAttributes`, not
          // `result.attributes`, because those are the values that land in the
          // record — and the whole point of the needles is to redact what is
          // PERSISTED. The two differ exactly when a provider declared `NoEcho`
          // and returned no fresh attributes, where the carried-forward set is
          // what state keeps.
          this.registerNoEchoAttributes(
            logicalId,
            {
              ...(carriedAttributes && { attributes: carriedAttributes }),
              ...(result.noEchoAttributes === true && { noEchoAttributes: true }),
              ...(result.noEchoAttributeNames && {
                noEchoAttributeNames: result.noEchoAttributeNames,
              }),
            },
            updateSecrets,
            resolvedProps
          );

          stateResources[logicalId] = {
            physicalId: result.physicalId,
            resourceType,
            properties: this.propertiesToRecord(
              resolvedProps,
              result,
              resourceType,
              resultProvisionedBy
            ),
            ...(carriedAttributes && { attributes: carriedAttributes }),
            ...(dependencies && dependencies.length > 0 && { dependencies }),
            ...this.extractTemplateAttributes(template, logicalId),
            provisionedBy: resultProvisionedBy,
            ...(keepsParameterRefusal && {
              observedBaselineRefused: true as const,
              observedBaselineRefusalReason: 'unverifiable-parameter' as const,
            }),
          };
          // 'update' even after the replacement fallback: a principal then
          // claims only on its own `Policies` change (the fewer claims).
          if (updatePartialReason(result) === undefined) {
            this.recordInlinePolicyWrite(logicalId, 'update');
          }

          if (keepsParameterRefusal) {
            // No readback is TAKEN, not merely not persisted: a value that is
            // never read cannot reach the record, the journal, an event or a
            // log line by any route.
            this.logger.debug(
              `observedProperties capture SKIPPED for updated ${logicalId} (${resourceType}): 'cdkd import' refused its baseline because a template parameter was not provably deployed at its 'Default', and this deploy bound the same 'Default' — an in-place update cannot show that AWS no longer holds the deployed value. The refusal stands until the resource is replaced or re-imported against a CloudFormation stack that proves the parameter.`
            );
          }
          const updateCaptureSiblings = keepsParameterRefusal
            ? undefined
            : await this.buildObservedCaptureSiblings(
                resourceType,
                logicalId,
                result.physicalId,
                template,
                stateResources,
                stackName,
                parameterValues,
                conditions
              );
          // `captureProvider`, NOT `updateProvider`: on the plain in-place
          // path they are the same binding, and on the replacement fallback
          // this is the provider that actually created `result.physicalId`
          // and the layer `provisionedBy` above was stamped with (issue
          // #2608).
          if (!keepsParameterRefusal) {
            this.kickOffObservedCapture(
              captureProvider,
              logicalId,
              result.physicalId,
              resourceType,
              resolvedProps,
              { ...updateCaptureSiblings, afterOwnWrite: true }
            );
          }

          // Issue #1819: the provider may have updated the resource and left
          // something behind. The row still counts as an update for ordering
          // and state purposes, but it is not a clean one, so it gets its own
          // counter and its own status line rather than printing `updated`
          // over a survivor the user is never told about.
          const updatePartial = updatePartialReason(result);
          if (counts) {
            if (updatePartial !== undefined) counts.updatePartial++;
            else counts.updated++;
          }
          if (progress) progress.current++;
          const updatePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          if (updatePartial !== undefined) {
            this.logger.warn(
              `${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)} ` +
                updatePartialMessage(updatePartial)
            );
            return { updatePartial };
          }
          this.logger.info(
            `${updatePrefix}${formatResourceLine('updated', logicalId, resourceType)}`
          );
        }
        break;
      }

      case 'DELETE': {
        const currentResource = existingState;
        if (!currentResource) {
          throw new Error(`Cannot delete ${logicalId}: resource not found in state`);
        }

        // Honor `DeletionPolicy: Retain` / `RetainExceptOnCreate`.
        // State is source of truth as of schema v5+ (cdkd records the
        // attribute on every successful create/update). The synth template
        // is consulted as a fallback for pre-v5 state that has no
        // `state.deletionPolicy` recorded yet — once that resource is
        // re-deployed under v5, the state value takes over and stays
        // authoritative even if the user removes the template attribute
        // mid-flight (a destroy mid-PR would otherwise silently downgrade
        // from Retain to Delete on a transient template edit).
        const deletionPolicy =
          currentResource.deletionPolicy ?? template?.Resources?.[logicalId]?.DeletionPolicy;
        if (shouldRetainResource(deletionPolicy)) {
          this.logger.info(
            `Retaining ${logicalId} (${resourceType}) - DeletionPolicy: ${deletionPolicy}`
          );
          delete stateResources[logicalId];
          break;
        }

        // Honor `DeletionPolicy: Snapshot` (issues #1352 / #1353) — see
        // prepareFinalSnapshotForDelete for the mechanism matrix.
        // Issue #4030: an absent policy is CloudFormation's default, which is
        // `Snapshot` for an RDS cluster or standalone instance.
        const governingPolicy = effectiveDeletionPolicy(
          resourceType,
          deletionPolicy,
          currentResource.properties
        );
        const finalSnapshotIdentifier = await this.prepareFinalSnapshotForDelete(
          logicalId,
          resourceType,
          currentResource,
          governingPolicy
        );

        // Schema v7+: route DELETE through the layer recorded on state
        // (`provisionedBy: 'cc-api'` → Cloud Control; absent / `'sdk'`
        // → SDK provider — legacy default).
        const deleteProvider = this.providerRegistry.getProviderFor({
          resourceType,
          provisionedBy: currentResource.provisionedBy,
        }).provider;

        this.logger.debug(`Deleting ${logicalId} (${resourceType})`);
        // Issue #1762: what the provider actually DID. `undefined` (the
        // back-compat `void` return) means "deleted"; a `'skipped'` outcome
        // means the resource was NOT deleted and may still be alive.
        let deleteResult: void | ResourceDeleteResult = undefined;
        const inlinePolicyClaimed = this.inlinePolicyClaimedFor(
          resourceType,
          logicalId,
          stateResources
        );
        try {
          deleteResult = await this.withRetry(
            () =>
              deleteProvider.delete(
                logicalId,
                currentResource.physicalId,
                resourceType,
                currentResource.properties,
                {
                  expectedRegion: this.stackRegion,
                  ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
                  ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
                  // Issue #4029: absent is CloudFormation's `Delete` here.
                  deletionPolicy: governingPolicy ?? 'Delete',
                  ...(this.options.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
                  // Issue #4157: the identity evidence of the record deleted.
                  recordedAttributes: currentResource.attributes,
                }
              ),
            logicalId,
            3, // fewer retries for DELETE
            5_000,
            deleteProvider
          );
        } catch (deleteError) {
          const msg = deleteError instanceof Error ? deleteError.message : String(deleteError);
          // Treat "not found" errors as success (resource already deleted) —
          // but never a USER ABORT (issues #2053 / #1952). The match is on the
          // MESSAGE, and an interrupt's message embeds a name the user chose, so
          // a logical id containing `NotFoundException` / `NoSuchEntity` made an
          // interrupted delete read as "already deleted" and dropped a live
          // resource from state. Typed check first: the substring match cannot
          // be made safe, because any needle can appear in a user-chosen name.
          //
          // The same holds for a DELIBERATE cdkd REFUSAL (issue #2301): the
          // Cloud Control pre-flight region check interpolates the LOGICAL ID
          // into its message, so a construct id containing `NotFoundException`
          // would make the refusal read as "already deleted" here and drop a
          // live foreign-region resource from state on the deploy path's
          // template-removal delete. Twin of the guard in
          // `destroy-runner.ts`; see the longer note there for why
          // `isMarkedNonRetryable` is the predicate.
          // `isWaitAbandonedError` is the THIRD member of this family (issue
          // go-to-k/cdkd#3236), and it needs its own predicate rather than
          // riding `isMarkedNonRetryable`: a DELETE abandonment is
          // deliberately left RETRYABLE so the delete can be re-issued, so it
          // carries no non-retryable marker and would fall straight through to
          // the substring match below.
          if (
            !isInterruptedWaitError(deleteError) &&
            !isMarkedNonRetryable(deleteError) &&
            !isWaitAbandonedError(deleteError) &&
            (msg.includes('does not exist') ||
              msg.includes('was not found') ||
              msg.includes('not found') ||
              msg.includes('No policy found') ||
              msg.includes('NoSuchEntity') ||
              msg.includes('NotFoundException') ||
              msg.includes('ResourceNotFoundException'))
          ) {
            this.logger.debug(
              `Resource ${logicalId} already deleted (${msg}), removing from state`
            );
          } else {
            throw deleteError;
          }
        }

        // Issue #1762: handled OUTSIDE the catch above on purpose — a skip is
        // a RETURN VALUE, so it can never be read by that block's
        // already-deleted message classifier, whatever a provider puts in
        // `reason`. Reading a skip as "already deleted" is precisely the
        // mis-accounting this branch used to commit.
        const deleteSkipped = deleteSkipReason(deleteResult);
        if (deleteSkipped !== undefined) {
          if (progress) progress.current++;
          const skipPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
          renderer.removeTask(logicalId);
          this.logger.info(
            `${skipPrefix}${formatResourceLine(
              'skipped',
              logicalId,
              resourceType,
              `skipped (${deleteSkipped})`
            )}`
          );
          this.logger.warn(
            deleteSkippedMessage(
              logicalId,
              currentResource.physicalId,
              deleteSkipped,
              'while removing it from the template'
            ) +
              `. Its cdkd state record was KEPT, so the next 'cdkd deploy' re-attempts the ` +
              `delete. Repair the record first (for a nested stack it is the CHILD's own ` +
              `state, whose other resources may already be gone), or delete the resource by ` +
              `hand and drop the record.` +
              // `--stack-region` on BOTH, and `state orphan` is why: without
              // it that command drops the record for this NAME IN EVERY REGION
              // (`orphanCommandFor`'s header in `export.ts` states the same
              // rule), so an operator repairing one region would silently
              // orphan the resources another region's record points at. M2 of
              // the go-to-k/cdkd#3499 review.
              `\nInspect it with: ${
                pasteableCommand('cdkd state show', [
                  { value: stackName, hole: 'stack' },
                  { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
                ]).command
              }` +
              `\nDrop the record with: ${
                pasteableCommand('cdkd state orphan', [
                  { value: stackName, hole: 'stack' },
                  { flag: '--stack-region', value: this.stackRegion, hole: 'region' },
                ]).command
              }`
          );
          // Deliberately NO `delete stateResources[logicalId]` and NO
          // `counts.deleted++`. Dropping the record is the data-loss half:
          // the user would have neither the AWS resource deleted nor a cdkd
          // record pointing at it. Keeping it also means the resource is
          // still diffed as a DELETE next run, which is why a skip here is a
          // warning rather than a resource failure — unlike `cdkd destroy`,
          // `cdkd deploy` self-heals on the next run.
          if (counts) counts.deleteSkipped++;
          return { deleteSkipped };
        }

        delete stateResources[logicalId];
        if (counts) counts.deleted++;
        if (progress) progress.current++;
        const deletePrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
        renderer.removeTask(logicalId);
        this.logger.info(
          `${deletePrefix}${formatResourceLine('deleted', logicalId, resourceType)}`
        );
        break;
      }
    }
  }

  /**
   * Create a resource with retry for transient errors
   *
   * Some resources fail immediately after their dependencies are created due to
   * AWS eventual consistency (e.g., Lambda fails if IAM Role hasn't propagated yet).
   * CloudFormation handles this internally; cdkd retries with exponential backoff.
   */
  /**
   * Extract ALL dependencies for a resource from the template.
   *
   * Uses TemplateParser.extractDependencies() to capture Ref, Fn::GetAtt,
   * and DependsOn dependencies. This ensures the state contains complete
   * dependency information for correct deletion ordering (not just DependsOn).
   *
   * Template Parameter names are filtered out (issue #1032): a `Ref` to a
   * CFn Parameter is not a provisioning-order edge, and the destroy-side
   * graph build (which reconstructs a pseudo-template from state with no
   * `Parameters` section) would warn `depends on <Param>, but <Param> not
   * found in template` for every parameter-referencing resource.
   */
  private extractAllDependencies(
    template: CloudFormationTemplate | undefined,
    logicalId: string
  ): string[] | undefined {
    const resource = template?.Resources?.[logicalId];
    if (!resource) return undefined;
    const parser = new TemplateParser();
    const parameterNames = new Set(Object.keys(template?.Parameters ?? {}));
    const deps = [...parser.extractDependencies(resource)].filter(
      (dep) => !parameterNames.has(dep)
    );
    return deps.length > 0 ? deps : undefined;
  }

  /**
   * The properties to RECORD in cdkd state for a just-provisioned resource.
   *
   * Normally the DESIRED (resolved) bag: state is the record of what the user
   * asked for, and the #1160 absent-field removal derivation reads it as the
   * previous side on the next deploy, so it must stay template-shaped.
   *
   * A provider may override it by returning `effectiveProperties` when it
   * deliberately NARROWED what it sent (issue #1591). Recording the desired
   * bag there would describe something AWS does not hold, and since
   * `readCurrentState` can only return what AWS does hold, the difference is
   * PERMANENT phantom drift — reported by every `cdkd drift`, and "repaired"
   * by `drift --revert` into another `update()` that narrows and re-reports.
   * The provider is the only layer that knows what it dropped, so it says so
   * and the engine records that instead.
   *
   * The SECOND narrowing (issue #2750) is the ROUTE's, not a provider's, and
   * the provider cannot report it: a silent-drop property is one the SDK
   * Provider has no wiring for at all, so it never sees the key to say it
   * dropped it. `provisionedBy === 'sdk'` is the whole condition — on that
   * route `getProviderFor` has already established that every silent drop in
   * this bag is allow-listed (an un-allowed one would have auto-routed the
   * resource to Cloud Control, which forwards the full map), so "what the SDK
   * route writes" and "what this deploy's flags permit dropping" are the same
   * set and no flag needs re-reading here.
   *
   * Recording the wider bag is what reopened the silent-drop class through the
   * state file: the record claimed a value AWS did not hold, so the later
   * Cloud Control re-route diffed the property as unchanged and its JSON Patch
   * omitted it. Every other reader of the bag was told the same lie —
   * `cdkd drift` (for a provider with no `readCurrentState`), rollback replay,
   * `cdkd export`, `cdkd state`.
   */
  private propertiesToRecord(
    desiredProperties: Record<string, unknown>,
    result: EffectivePropertiesResult,
    resourceType: string,
    provisionedBy: 'sdk' | 'cc-api'
  ): Record<string, unknown> {
    // Issue #2516: the desired bag is THIS pass's own resolution of today's
    // template and the provider just succeeded with it, so the object state
    // will hold is marked same-generation — the one fact the persist choke
    // point needs to write an embedded 1-3 character secret as its token
    // rather than leaving it in plaintext below the value scan's needle
    // floor. An `effectiveProperties` replacement is NOT marked: a provider
    // may carry previous-state values into it (the DynamoDB global-table
    // provider restores the previous GSIs and billing mode), so an
    // object-level mark on it would vouch for leaves this pass never
    // resolved. Such a bag keeps the residual, stated on
    // `positionByEmbeddedSpan`.
    //
    // The mark goes on AFTER the route's silent-drop narrowing (issue #2750),
    // never before: that helper returns a NEW object whenever it drops a key,
    // so a mark taken first would sit on an object the record never holds.
    // Narrowing a bag this pass resolved leaves it this pass's own, so the
    // mark is still the engine's to make.
    if (result.effectiveProperties) {
      return provisionedBy === 'sdk'
        ? withoutSilentDropProperties(resourceType, result.effectiveProperties)
        : result.effectiveProperties;
    }
    const written =
      provisionedBy === 'sdk'
        ? withoutSilentDropProperties(resourceType, desiredProperties)
        : desiredProperties;
    return markSameGenerationBag(written);
  }

  /**
   * Read `DeletionPolicy` / `UpdateReplacePolicy` from the synth template
   * so they can be persisted in `ResourceState` (schema v5+). Always returns
   * both keys (`undefined` when the template does not carry the attribute)
   * so that spreading into an existing `ResourceState` reliably overrides a
   * previously-recorded value back to `undefined` — required when the user
   * removes the attribute from their CDK code. `JSON.stringify` then omits
   * the `undefined` keys when state is serialized to S3.
   */
  private extractTemplateAttributes(
    template: CloudFormationTemplate | undefined,
    logicalId: string
  ): {
    deletionPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
    updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
  } {
    const resource = template?.Resources?.[logicalId];
    return {
      deletionPolicy: resource?.DeletionPolicy,
      updateReplacePolicy: resource?.UpdateReplacePolicy,
    };
  }

  // Type-based implicit deletion ordering rules are defined in
  // src/analyzer/implicit-delete-deps.ts so the deploy DELETE phase and the
  // standalone destroy command apply the same rules.

  /**
   * Build a per-resource map of "must be deleted before me" dependencies for
   * the DELETE phase, derived from state-recorded dependencies plus implicit
   * type-based ordering rules.
   *
   * For a resource X, the returned set contains every resource Y such that Y
   * must finish deleting before X starts — i.e., Y depends on X (or is otherwise
   * required to vanish first per implicit type rules).
   */
  /**
   * Returns true if the executor still has un-started pending nodes —
   * used to distinguish "SIGINT cancelled real work" from "SIGINT landed
   * after all nodes already completed" (the latter should not error).
   */
  private hasPending<T>(executor: DagExecutor<T>): boolean {
    for (const node of executor.values()) {
      if (node.state === 'pending') return true;
    }
    return false;
  }

  private buildDeletionDependencies(
    deleteIds: Set<string>,
    state: StackState
  ): Map<string, Set<string>> {
    const dependedBy = new Map<string, Set<string>>();
    for (const id of deleteIds) {
      dependedBy.set(id, new Set());
    }

    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (!resource?.dependencies) continue;
      for (const dep of resource.dependencies) {
        if (!deleteIds.has(dep)) continue;
        // id depends on dep → dep must be deleted AFTER id (i.e., id is in dep's deletion deps)
        dependedBy.get(dep)!.add(id);
      }
    }

    this.addImplicitDeleteDependencies(deleteIds, state, dependedBy);

    return dependedBy;
  }

  /**
   * Add implicit delete dependency edges based on resource type relationships.
   *
   * Some AWS resources have ordering constraints during deletion that are NOT
   * expressed via Ref/GetAtt in CloudFormation templates. For example, an
   * InternetGateway cannot be deleted until its VPCGatewayAttachment is removed,
   * even though the attachment references the IGW (not the other way around).
   *
   * This method inspects resource types and adds edges so that dependents
   * (e.g., VPCGatewayAttachment) are deleted BEFORE the resources they implicitly
   * depend on (e.g., InternetGateway).
   */
  private addImplicitDeleteDependencies(
    deleteIds: Set<string>,
    state: StackState,
    dependedBy: Map<string, Set<string>>
  ): void {
    // Build a type → logical IDs index for resources being deleted
    const typeToIds = new Map<string, string[]>();
    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (!resource) continue;
      const ids = typeToIds.get(resource.resourceType) ?? [];
      ids.push(id);
      typeToIds.set(resource.resourceType, ids);
    }

    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (!resource) continue;

      const mustDeleteAfter = IMPLICIT_DELETE_DEPENDENCIES[resource.resourceType];
      if (!mustDeleteAfter) continue;

      for (const depType of mustDeleteAfter) {
        const depIds = typeToIds.get(depType);
        if (!depIds) continue;

        for (const depId of depIds) {
          // depId (of depType) must be deleted BEFORE id (of resource.resourceType)
          // In the dependedBy map: id is "depended on" by depId
          // meaning depId will be picked first (deleted first)
          if (!dependedBy.has(id)) dependedBy.set(id, new Set());
          if (!dependedBy.get(id)!.has(depId)) {
            dependedBy.get(id)!.add(depId);
            this.logger.debug(
              `Implicit delete dependency: ${depId} (${depType}) must be deleted before ${id} (${resource.resourceType})`
            );
          }
        }
      }
    }

    // Per-resource implicit delete edges that cannot be inferred from a
    // type-pair rule (e.g. CompositeAlarm -> the metric alarms its AlarmRule
    // references by name, which carry no Ref / Fn::GetAtt edge).
    const scoped: Record<string, ResourceState> = {};
    for (const id of deleteIds) {
      const resource = state.resources[id];
      if (resource) scoped[id] = resource;
    }
    for (const { before, after } of computeImplicitDeleteEdges(scoped)) {
      // `before` must be deleted before `after`, so `before` is in `after`'s
      // deletion deps (picked / deleted first).
      if (!dependedBy.has(after)) dependedBy.set(after, new Set());
      if (!dependedBy.get(after)!.has(before)) {
        dependedBy.get(after)!.add(before);
        this.logger.debug(
          `Implicit delete dependency: ${before} (${scoped[before]?.resourceType}) must be deleted before ${after} (${scoped[after]?.resourceType})`
        );
      }
    }
  }

  /**
   * Prepare a property map for a Cloud Control API call. When a Tier 1
   * resource is routed via Cloud Control (either because the user's
   * template hit silent-drop properties under #614 or because the resource
   * is sticky-routed via `provisionedBy: 'cc-api'`), CC requires the full
   * property map — including identifier-like fields (`BucketName`,
   * `RoleName`, etc.) that the SDK provider would have auto-generated.
   * This helper threads the property prep through the registered SDK
   * provider's `preparePropertiesForFallback` hook when defined, falling
   * back to `applyDefaultNameForFallback` (which mints stack-prefixed
   * names matching what the SDK provider would have done) otherwise.
   *
   * A type with no registered SDK provider (Tier 2 / CC-native) takes the
   * `applyDefaultNameForFallback` arm too, which fills a name only when the
   * type has a `FALLBACK_NAME_RULES` entry (`AWS::Lambda::CapacityProvider`,
   * issue #3174) and returns the bag unchanged otherwise. An UPDATE drops the
   * generated name again (`withoutGeneratedFallbackName`).
   */
  private preparePropertiesForCcApi(
    resourceType: string,
    resolvedProps: Record<string, unknown>,
    logicalId: string
  ): Record<string, unknown> {
    const sdkProvider = this.providerRegistry.getRegisteredTypes().includes(resourceType)
      ? this.providerRegistry.getProvider(resourceType)
      : undefined;
    if (sdkProvider?.preparePropertiesForFallback) {
      return sdkProvider.preparePropertiesForFallback(logicalId, resourceType, resolvedProps);
    }
    return applyDefaultNameForFallback(logicalId, resourceType, resolvedProps);
  }

  /**
   * Execute an operation with retry for transient IAM propagation errors.
   *
   * Thin wrapper over `withRetry` from ./retry.js that injects this engine's
   * SIGINT-aware interrupt check and logger. The actual backoff schedule
   * lives there.
   *
   * When the provider opts out via `disableOuterRetry`, the operation is
   * invoked exactly once and the retry loop is skipped entirely. The
   * Custom Resource provider uses this to avoid re-running its `create()`
   * — each invocation derives a fresh pre-signed S3 URL and RequestId,
   * so an outer retry leaves the previous attempt's Lambda response
   * stranded at an S3 key nobody polls.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    logicalId: string,
    maxRetries?: number,
    initialDelayMs?: number,
    provider?: ResourceProvider
  ): Promise<T> {
    if (provider?.disableOuterRetry) {
      // Single-shot — provider handles transient errors internally.
      return operation();
    }
    return withRetry(operation, logicalId, {
      ...(maxRetries !== undefined && { maxRetries }),
      ...(initialDelayMs !== undefined && { initialDelayMs }),
      logger: this.maskingRetryLogger(logicalId),
      isInterrupted: () => this.interrupted,
      onInterrupted: () => new InterruptedError(this.interruptCause ?? 'user'),
    });
  }

  /**
   * Mask one line of engine-authored text with a resource's OWN recorded
   * secrets (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038)).
   *
   * Per-resource, never session-wide — see the `perResourceSecrets` field doc
   * for why one resource's secret must not rewrite another's literal. A
   * `logicalId` with no entry (or an empty bag) forwards verbatim, so every
   * non-secret resource is byte-identical to before.
   */
  private maskForResource(logicalId: string, text: string): string {
    return maskSecretsInText(text, this.perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS);
  }

  /**
   * The LAZY `RetryLogger` the engine's generic `withRetry` wrapper threads
   * (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038) acceptance
   * item 1) — the same masking shape `drift.ts` and `rollback-executor.ts`
   * install, bound to the resource's OWN recorded secrets.
   *
   * `retry.ts` interpolates the AWS message verbatim into both the per-attempt
   * `debug` line and the give-up `warn` summary, and the bag this engine hands
   * a provider is RESOLVED — `perResourceSecrets` is populated immediately after
   * `resolver.resolve` and BEFORE the create / update call, so a secret is in
   * scope at every retried provider call. An AWS validation error routinely
   * quotes the offending value back, so the give-up summary could print it at
   * DEFAULT verbosity: the same hole #2038 found on the rollback path, one
   * caller over.
   *
   * The bag is resolved PER LINE rather than captured, because `withRetry`
   * (the private wrapper below) is reached from call sites that hold no bag —
   * DELETE, the observed-capture drain, the Outputs pass — and a
   * `logicalId`-keyed read is the only thing available there. The two
   * `--replace` sites do hold their caller's bag and use
   * {@link maskingRetryLoggerFor} instead; see the note on
   * {@link replaceDeleteFirstAndRecreate}'s `secrets` parameter for why binding
   * the bag beats looking it up whenever the bag is in scope.
   *
   * Do NOT restate that the engine "already masked its own error text" — an
   * earlier revision of this comment did, and it was FALSE: `provisionResource`
   * logged the raw AWS message at `error` level (a HIGHER level than this
   * summary) until #2038's review round. Only the EVENT store was masked.
   */
  private maskingRetryLogger(logicalId: string): RetryLogger {
    return {
      debug: (msg) => this.logger.debug(this.maskForResource(logicalId, msg)),
      warn: (msg) => this.logger.warn(this.maskForResource(logicalId, msg)),
    };
  }

  /**
   * The EAGER `RetryLogger`, bound to the bag the caller actually resolved
   * with (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038)).
   *
   * Preferred over {@link maskingRetryLogger} wherever the resolution pass's
   * own `RecordedSecretValues` is in scope, for the reason
   * {@link replaceDeleteFirstAndRecreate}'s parameter list already states about
   * the masker it threads: a map looked up by logical id is a DIFFERENT thing
   * from the bag this call resolved with, and one file must not argue both
   * sides. It delegates to the shared `masking-retry-logger.ts` so the deploy
   * engine, `rollback-executor.ts` and `drift.ts` cannot drift apart.
   */
  private maskingRetryLoggerFor(secrets: RecordedSecretValues): RetryLogger {
    return maskingRetryLogger(this.logger, secrets);
  }
}

DeployEngine.prototype.kickOffObservedCapture = observedCaptureMixin.kickOffObservedCapture;
DeployEngine.prototype.drainObservedCaptures = observedCaptureMixin.drainObservedCaptures;
DeployEngine.prototype.buildObservedCaptureSiblings =
  observedCaptureMixin.buildObservedCaptureSiblings;
DeployEngine.prototype.stampReasonlessParameterRefusals =
  observedCaptureMixin.stampReasonlessParameterRefusals;
DeployEngine.prototype.kickOffAutoRefreshObservedProperties =
  observedCaptureMixin.kickOffAutoRefreshObservedProperties;
DeployEngine.prototype.kickOffMaskedBaselineRecapture =
  observedCaptureMixin.kickOffMaskedBaselineRecapture;

DeployEngine.prototype.adoptRollbackOrphans = rollbackMixin.adoptRollbackOrphans;
DeployEngine.prototype.performRollback = rollbackMixin.performRollback;
DeployEngine.prototype.settleJournalAfterSuccess = rollbackMixin.settleJournalAfterSuccess;
DeployEngine.prototype.deleteRollbackJournalBestEffort =
  rollbackMixin.deleteRollbackJournalBestEffort;
DeployEngine.prototype.settleJournalAfterCleanRollback =
  rollbackMixin.settleJournalAfterCleanRollback;
DeployEngine.prototype.settleNestedChildrenAfterCleanRollback =
  rollbackMixin.settleNestedChildrenAfterCleanRollback;
DeployEngine.prototype.recoveryHint = rollbackMixin.recoveryHint;
DeployEngine.prototype.rollbackExecutorContext = rollbackMixin.rollbackExecutorContext;
DeployEngine.prototype.producerRegionEvidence = rollbackMixin.producerRegionEvidence;
DeployEngine.prototype.writeRollbackJournalSegment = rollbackMixin.writeRollbackJournalSegment;
DeployEngine.prototype.redactOperationsForJournal = rollbackMixin.redactOperationsForJournal;

DeployEngine.prototype.handleOutputResolutionFailure = outputsMixin.handleOutputResolutionFailure;
DeployEngine.prototype.resolveOutputs = outputsMixin.resolveOutputs;
DeployEngine.prototype.buildDisplayOutputs = outputsMixin.buildDisplayOutputs;

DeployEngine.prototype.replacementNameOrigin = nameCollisionMixin.replacementNameOrigin;
DeployEngine.prototype.orphanedNameCollisionAdvice = nameCollisionMixin.orphanedNameCollisionAdvice;
