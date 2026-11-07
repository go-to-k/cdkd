import { getLogger } from '../utils/logger.js';
import type { GeneratedNameGuard } from './generated-name-guard.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import { type RecordedSecretValues } from './secret-redaction.js';
import { KEEP_REFERENCE_PROVENANCE } from './reference-provenance-record.js';
import { ProvenanceCapture } from './deploy-engine/provenance-capture.js';
import { ReplacementRunState, type ReplacementDeps } from './deploy-engine/replacement.js';
import {
  isInlinePolicyClaimedByCompletedWriter,
  isInlinePolicyPrincipalType,
  isStandaloneInlinePolicyType,
  type InlinePolicyWrite,
} from './inline-policy-claims.js';
import type { StackRecordsView } from './stack-records-scope.js';
import type {
  CloudFormationTemplate,
  InlinePolicyClaimed,
  ResourceProvider,
} from '../types/resource.js';
import {
  type ReferenceProvenance,
  type StackState,
  type StateImportEntry,
  type StateOutputReadEntry,
  type ResourceState,
  type ResourceChange,
} from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import type { LockManager } from '../state/lock-manager.js';
import type { ExportIndexStore } from '../state/export-index-store.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import { ProviderRegistry } from '../provisioning/provider-registry.js';
import { TemplateParser } from '../analyzer/template-parser.js';
import { withRetry, type RetryLogger } from './retry.js';
import { maskingRetryLogger } from './masking-retry-logger.js';
import {
  DEFAULT_RESOURCE_TIMEOUT_MS,
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  type DeployEngineOptions,
  type DeployResult,
} from './deploy-engine/options.js';
import { OutputsRunState, type OutputsDeps } from './deploy-engine/outputs.js';
import type { RollbackDeps } from './deploy-engine/rollback.js';
import { ObservedCapture } from './deploy-engine/observed-capture.js';
import {
  SecretsRunState,
  maskForResource,
  maskedRecordRemedyFor,
  type MaskingDeps,
} from './deploy-engine/masking.js';
import { AttributeHealer } from './deploy-engine/attribute-healer.js';
import type { DeleteDeps } from './deploy-engine/delete.js';
import { type ResolverContextDeps } from './deploy-engine/resolver-context.js';
import { NoEchoRunState, type NoEchoDeps } from './deploy-engine/noecho.js';
import type { ProducerRegionEvidence } from './producer-regions-scope.js';
import {
  crossStackReadKeyNormalizer,
  outputReferenceProvenanceFor,
  redactCrossStackReads,
  redactStateForPersist,
  referenceProvenanceToPersist,
  withParentInfo,
} from './deploy-engine/state-persist.js';
import {
  deleteDeps,
  freshObservedCapture,
  freshProvenanceCapture,
  maskingDeps,
  noEchoDeps,
  outputsDeps,
  rebaseline,
  replacementDeps,
  resolverContextDeps,
  rollbackDeps,
} from './deploy-engine/engine-deps.js';
import { deploy, doDeploy } from './deploy-engine/deploy-run.js';
import { maskSecretsInEvent } from './deploy-engine/event-masking.js';
export {
  DEFAULT_RESOURCE_TIMEOUT_MS,
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  type DeployEngineOptions,
  type DeployResult,
} from './deploy-engine/options.js';
export { deriveLabelRouting, type LabelRoutingState } from './label-routing.js';
export { crossStackReadsForPartialSave } from './deploy-engine/state-persist.js';

/**
 * The bag a resource with no recorded secret masks against (issue #2038).
 * Shared so the "no entry" path allocates nothing and — more usefully — so
 * every masking site takes the SAME branch: `maskSecretsInText` /
 * `maskSecretsInError` both return their input unchanged for an empty bag, so
 * an absent entry and an empty one cannot behave differently. Never written to.
 */
export const EMPTY_SECRETS: RecordedSecretValues = new Map();

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
export type ResourceOutcomeSignal = Partial<DeleteSkipSignal> & Partial<UpdatePartialSignal>;

/**
 * Per-resource operation tallies threaded through `provisionResource`.
 *
 * `skipped` and `deleteSkipped` are NOT the same thing and must never be
 * merged: `skipped` counts resources whose UPDATE resolved to no actual
 * change (it feeds `DeployResult.unchanged`), while `deleteSkipped` counts
 * DELETEs a provider refused to issue (issue #1762) — a resource that is
 * still alive and still in state.
 */
export interface ProvisionCounts {
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
  /**
   * The part of `updatePartial` a nested-stack descendant reported (issue
   * #1989), already included in `updatePartial`. Kept apart so the summary can
   * tell this stack's own partial rows from a child's.
   */
  nestedUpdatePartial: number;
  /**
   * go-to-k/cdkd#4705 (review R6-5): replacements decided late, on a readback,
   * that the cross-prefix check refused (another state prefix records the
   * stack, or the check could not run): the old resource is kept and the new
   * value not applied. Unaddressed, like `deleteSkipped`, but not a delete.
   * Optional so the many count literals need not carry it: read as 0.
   */
  crossPrefixKept?: number;
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

export class InterruptedError extends Error {
  constructor(reason: InterruptCause = 'user') {
    super(
      reason === 'user'
        ? 'Deployment interrupted by user (Ctrl+C)'
        : 'Deployment aborted after another resource failed'
    );
    this.name = 'InterruptedError';
  }
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
   * Set by the SIGINT handler whatever `interruptCause` already holds: a
   * sibling's failure claims the cause first, and a Ctrl-C after it must still
   * stop the work only the user may stop (a re-create whose old resource is
   * gone, go-to-k/cdkd#5118).
   */
  /** @internal */
  userInterrupted = false;

  /**
   * The journal-key version purge a deploy starts when it finds no rollback
   * journal (`deploy-flow.ts` step 1b); the success settle awaits it in place
   * of its own delete and purge. Never rejects.
   * @internal
   */
  absentJournalVersionPurge: Promise<void> | undefined;
  /**
   * The cap on the readback that decides a fresh-`NoEcho` replacement ceiling
   * (go-to-k/cdkd#3729). Outliving it keeps the replacement. A field rather
   * than a constant only so a test can shorten it.
   */
  /** @internal */
  noEchoCeilingReadbackTimeoutMs = 30_000;
  /**
   * This deploy's `observedProperties` capture pipeline (the deploy-time
   * `readCurrentState` reads, their drain, and the masked-baseline
   * re-capture), replaced per `deploy()` by {@link freshObservedCapture}.
   */
  /** @internal */
  observedCapture: ObservedCapture;
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
   * This deploy's secret-masking and masked-property fingerprint state — the
   * ten fields {@link SecretsRunState} holds (`perResourceSecrets`,
   * `secretNameNeedles`, `perResourceTemplateProps`, `perResourceResolvedType`,
   * `fingerprintNoEchoValues`, `preDeploySecretNamedRecords`,
   * `storedNoEchoNamingValues`, `fingerprintParameters`,
   * `fingerprintChildTemplates`, `perResourceInputFingerprints`) — replaced,
   * not cleared in place, per `deploy()`, like {@link noEchoRun}.
   */
  /** @internal */
  secretsRun: SecretsRunState = new SecretsRunState();
  /**
   * This deploy's `NoEcho` positional-arm state — the ten fields
   * {@link NoEchoRunState} holds (`noEchoAttributeResources`,
   * `persistedNoEchoAttributes`, `noEchoConditions`,
   * `inheritedNoEchoParameters`, `noEchoPhysicalIdWarned`,
   * `noEchoPositionedValues`, `noEchoExactEchoes`, `noEchoAttributeReads`,
   * `witnessConfirmedLeaves`, `constructPathTemplate`) — replaced, not cleared
   * in place, per `deploy()`, like {@link outputsRun}.
   */
  /** @internal */
  noEchoRun: NoEchoRunState = new NoEchoRunState();
  /**
   * This deploy's replacement bookkeeping — the ten fields
   * {@link ReplacementRunState} holds (`replacedDeleteSkips`,
   * `deferredReplacedDeletes`, `retainedOldOnReplacement`,
   * `replacedOldMaySurvive`, `recreatedUnderSameId`, `restoredLostChildren`,
   * `updatesThatSentNothing`, `updateWasReplaced`, `inPlaceCreateOnlyPaths`,
   * `oldDeletedBeforeCreate`) — replaced, not cleared in place, per
   * `deploy()`, like {@link secretsRun}.
   */
  /** @internal */
  replacementRun: ReplacementRunState = new ReplacementRunState();
  /**
   * This deploy's Outputs-pass state — the ten fields {@link OutputsRunState}
   * holds (`outputSecrets`, `outputsPassSecretMaps`, `outputsTemplateSource`,
   * `resolvedExportNames`, `carriedExportAliasRefusal`, `skippedOutputs`,
   * `outputsSourceUsable`, `outputProvenanceSinks`, `outputsResolvedThisRun`,
   * `resolvedOutputsBag`) — replaced, not cleared in place, per `deploy()`,
   * like {@link attributeHealer} / {@link provenanceCapture} /
   * {@link observedCapture}.
   */
  /** @internal */
  outputsRun: OutputsRunState = new OutputsRunState();

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
   * go-to-k/cdkd#5380: per logical id, the top-level property names this
   * deploy's `update()` declared (`UpdateContext.markUnsettled`) it was about
   * to change with an irreversible call. Held HERE, outside the provider's
   * promise, so a mark survives the per-resource deadline's race, Ctrl-C and a
   * retried attempt; a successful update deletes its entry, a failed one is
   * recorded on the resource's record at the failure save.
   */
  /** @internal */
  unsettledMarks = new Map<string, Set<string>>();

  /**
   * go-to-k/cdkd#5498: per logical id, the item names (per member path) this
   * deploy's `update()` declared ACCEPTED for adding (`markAttempted`). Kept
   * beside {@link unsettledMarks} and dropped with it.
   */
  /** @internal */
  unsettledItemMarks = new Map<string, Map<string, Set<string>>>();

  /**
   * go-to-k/cdkd#5505: per logical id, the provisioning body still running,
   * including one the per-resource deadline abandoned (it keeps running after
   * the race rejects). The automatic rollback waits for the one a failed
   * UPDATE left, so it cannot write after the revert, and considers that
   * update even when the deadline fired before its first mark: the call may
   * mark later, or complete. Resolves whether the body succeeded, never
   * rejects; each entry removes itself when its body settles.
   */
  /** @internal */
  inFlightBodies = new Map<string, Promise<boolean>>();

  /**
   * go-to-k/cdkd#3252: the Cloud Control CREATEs an earlier run stopped
   * waiting for that completed in AWS, by logical id, which this deploy's
   * CREATE of that logical id takes over instead of making another
   * (`create.ts`). Filled at deploy start (`deploy-flow.ts` step 1b-pre);
   * one left untaken by a successful deploy becomes a proven orphan.
   */
  /** @internal */
  resumedCreates = new Map<
    string,
    {
      requestToken: string;
      identifier: string;
      resourceType: string;
      attemptedProperties: Record<string, unknown>;
      /** Set when the CREATE took the resource over (`create.ts`). */
      taken?: boolean;
      /** Set when the takeover's read found the resource gone. */
      gone?: boolean;
    }
  >();

  /**
   * go-to-k/cdkd#4705: this deploy's plan-time check of the generated names
   * its name-adopting creates would take; each create awaits its verdict.
   * Reset per deploy.
   */
  /** @internal */
  generatedNameGuard: GeneratedNameGuard | undefined;

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
   * State schema v12: the loaded record's outputs bag and its provenance, for
   * a save that carries that bag. Set at load, cleared per `deploy()`.
   */
  /** @internal */
  provenanceBaseline:
    | (Pick<StackState, 'outputs' | 'outputReferenceProvenance'> & { tokenFree: boolean })
    | undefined = undefined;

  /**
   * State schema v12: this deploy's one-time migration capture
   * (`deploy-engine/provenance-capture.ts`), holding its in-flight tasks until
   * they are drained with the observed captures before a save. Replaced (not
   * cleared in place) per `deploy()`, like {@link attributeHealer}.
   */
  /** @internal */
  provenanceCapture: ProvenanceCapture;

  /**
   * The pre-deploy state records, as loaded — the #1852 heal's eligibility
   * baseline. A record is healed only while it is still the one this deploy
   * LOADED (same physical id, same `attributes` object): once a provider has
   * (re)written it this run, a missing attribute is the provider's answer, not
   * staleness, and re-reading would cost an AWS call to learn nothing. See
   * {@link AttributeHealer.isEligible}. Held by {@link attributeHealer}, so
   * the two cannot disagree; set through {@link rebaseline}.
   * @internal
   */
  get healBaseline(): Readonly<Record<string, ResourceState>> {
    return this.attributeHealer.baseline;
  }
  /**
   * This deploy's producer-region evidence (`producerRegionEvidence` over the
   * state it loaded and the reads it has made), for the resolver's
   * recorded-reference re-resolution (go-to-k/cdkd#4805). Per-deploy, like
   * `healBaseline`; `undefined` before the state loads.
   * @internal
   */
  runProducerRegionEvidence: (() => ProducerRegionEvidence) | undefined = undefined;
  /**
   * go-to-k/cdkd#4156: this deploy's diff, read by `inlinePolicyClaimedFor` to
   * tell whether a principal's completed update put its `Policies`.
   * Per-deploy, like `healBaseline`.
   */
  /** @internal */
  deployChanges: ReadonlyMap<string, ResourceChange> = new Map();
  /**
   * go-to-k/cdkd#4821: this deploy's live state bag, set by
   * `executeDeployment` before its first provider call, read by a
   * replacement's delete of its old copy to ask `inlinePolicyClaimedFor`.
   * Per-deploy, like `healBaseline`.
   */
  /** @internal */
  deployStateResources: Record<string, ResourceState> = {};
  /**
   * go-to-k/cdkd#4492: this deploy's view of the stack's records, bound around
   * each resource's provider call (`stack-records-scope.ts`); set by
   * `executeDeployment` before its first provider call.
   */
  /** @internal */
  stackRecordsView: StackRecordsView | undefined = undefined;
  /**
   * go-to-k/cdkd#4156: the resources whose provider create / update
   * COMPLETED in this deploy, recorded right after their state record is
   * written. Per-deploy, like `healBaseline`.
   */
  /** @internal */
  inlinePolicyWriters = new Map<string, InlinePolicyWrite>();

  /**
   * This deploy's #1852 heal, holding {@link healBaseline}; replaced by
   * {@link rebaseline}, so a reused engine never serves last deploy's read
   * nor persists it against today's records.
   * @internal
   */
  attributeHealer: AttributeHealer;

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
      ...(options.producerLookup && { producerLookup: options.producerLookup }),
      ...(options.consumerAccount && { consumerAccount: options.consumerAccount }),
    });
    this.options.concurrency = options.concurrency ?? 20;
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
    this.attributeHealer = this.rebaseline({});
    this.provenanceCapture = this.freshProvenanceCapture();
    this.observedCapture = this.freshObservedCapture();
  }

  /** @internal */
  freshObservedCapture(): ObservedCapture {
    return freshObservedCapture.call(this);
  }

  /** @internal */
  rebaseline(resources: Readonly<Record<string, ResourceState>>): AttributeHealer {
    return rebaseline.call(this, resources);
  }

  /** @internal */
  freshProvenanceCapture(): ProvenanceCapture {
    return freshProvenanceCapture.call(this);
  }

  /** @internal */
  outputsDeps(): OutputsDeps {
    return outputsDeps.call(this);
  }

  /** @internal */
  noEchoDeps(): NoEchoDeps {
    return noEchoDeps.call(this);
  }

  /** @internal */
  maskingDeps(): MaskingDeps {
    return maskingDeps.call(this);
  }

  /** @internal */
  replacementDeps(): ReplacementDeps {
    return replacementDeps.call(this);
  }

  /** @internal */
  resolverContextDeps(): ResolverContextDeps {
    return resolverContextDeps.call(this);
  }

  /** @internal */
  deleteDeps(): DeleteDeps {
    return deleteDeps.call(this);
  }

  /** @internal */
  rollbackDeps(): RollbackDeps {
    return rollbackDeps.call(this);
  }

  /**
   * Deploy a CloudFormation template
   */
  deploy(stackName: string, template: CloudFormationTemplate): Promise<DeployResult> {
    return deploy.call(this, stackName, template);
  }

  /** @internal Body in `deploy-engine/masking.ts` (#4200). */
  static maskedRecordRemedyFor = maskedRecordRemedyFor;

  /** @internal */
  redactStateForPersist(state: StackState): StackState {
    return redactStateForPersist.call(this, state);
  }

  /** @internal */
  outputReferenceProvenanceFor(
    outputs: Record<string, unknown>,
    redacted: Record<string, unknown>
  ): Record<string, Record<string, ReferenceProvenance>> | undefined {
    return outputReferenceProvenanceFor.call(this, outputs, redacted);
  }

  /** @internal */
  referenceProvenanceToPersist(
    logicalId: string,
    record: ResourceState,
    scrubbed: ResourceState,
    secrets: RecordedSecretValues | undefined
  ): Record<string, ReferenceProvenance> | undefined | typeof KEEP_REFERENCE_PROVENANCE {
    return referenceProvenanceToPersist.call(this, logicalId, record, scrubbed, secrets);
  }

  /** @internal */
  redactCrossStackReads(state: StackState): Pick<StackState, 'imports' | 'outputReads'> {
    return redactCrossStackReads.call(this, state);
  }

  /** @internal */
  crossStackReadKeyNormalizer(): (name: string) => string {
    return crossStackReadKeyNormalizer.call(this);
  }

  /** @internal */
  withParentInfo(state: StackState): StackState {
    return withParentInfo.call(this, state);
  }

  /**
   * go-to-k/cdkd#4156: the live predicate handed to an `AWS::IAM::Policy`
   * update or delete, and to an `AWS::IAM::Role` / `Group` / `User` (only
   * their updates read it: a principal's delete removes every inline policy
   * with the principal), so it does not remove a name another resource of this
   * deploy has ALREADY written onto a principal
   * (`src/deployment/inline-policy-claims.ts`). It reads the writers' records
   * at call time. `undefined` for every other type.
   */
  /** @internal */
  inlinePolicyClaimedFor(
    resourceType: string,
    logicalId: string,
    stateResources: Record<string, ResourceState>
  ): InlinePolicyClaimed | undefined {
    // go-to-k/cdkd#4227: a role / group / user update too — it removes the
    // names its `Policies` drops, which a policy ordered before it may have
    // just put there (the rollback twin already asks it).
    // go-to-k/cdkd#4821: and a standalone `AWS::IAM::RolePolicy` /
    // `GroupPolicy` / `UserPolicy` delete (a DELETE row, or a replacement's
    // delete of its old copy), which leaves a name another writer took.
    if (
      resourceType !== 'AWS::IAM::Policy' &&
      !isInlinePolicyPrincipalType(resourceType) &&
      !isStandaloneInlinePolicyType(resourceType)
    ) {
      return undefined;
    }
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
  /** @internal */
  recordInlinePolicyWrite(logicalId: string, write: InlinePolicyWrite): void {
    this.inlinePolicyWriters.set(logicalId, write);
  }

  /** @internal */
  doDeploy(stackName: string, template: CloudFormationTemplate): Promise<DeployResult> {
    return doDeploy.call(this, stackName, template);
  }

  /**
   * #808 — forward one structured deployment event to the optional
   * recorder. No-op when no recorder was supplied. `record()` is
   * contractually synchronous and never-throwing, but we still guard
   * with a try/catch so an event emission can NEVER abort a deploy.
   *
   * Masked by the printing bags bound where it is recorded too
   * (go-to-k/cdkd#3869), as its log lines beside it are: a nested child's
   * engine runs under its parent row's derived-name registry, whose needles
   * (a parent-passed secret-named value) its own `printingSecretsFor` lacks.
   * See {@link maskSecretsInEvent}.
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

  /** @internal */
  maskSecretsInEvent<
    T extends {
      logicalId?: string;
      error?: { message?: string; ownLines?: boolean };
      reason?: string;
    },
  >(event: T): T {
    return (maskSecretsInEvent<T>).call(this, event);
  }

  // Type-based implicit deletion ordering rules are defined in
  // src/analyzer/implicit-delete-deps.ts so the deploy DELETE phase and the
  // standalone destroy command apply the same rules.

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
  /** @internal */
  async withRetry<T>(
    operation: () => Promise<T>,
    logicalId: string,
    maxRetries?: number,
    initialDelayMs?: number,
    provider?: ResourceProvider,
    /**
     * go-to-k/cdkd#5118: only the user's interrupt stops this retry, never a
     * sibling's failure -- set by a re-create whose old resource is already
     * deleted, where an abort leaves neither copy.
     */
    interruptOnlyByUser?: boolean
  ): Promise<T> {
    if (provider?.disableOuterRetry) {
      // Single-shot — provider handles transient errors internally.
      return operation();
    }
    return withRetry(operation, logicalId, {
      ...(maxRetries !== undefined && { maxRetries }),
      ...(initialDelayMs !== undefined && { initialDelayMs }),
      logger: this.maskingRetryLogger(logicalId),
      isInterrupted: () => (interruptOnlyByUser === true ? this.userInterrupted : this.interrupted),
      onInterrupted: () =>
        new InterruptedError(
          interruptOnlyByUser === true ? 'user' : (this.interruptCause ?? 'user')
        ),
    });
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
   * `replacement.ts`'s `replaceDeleteFirstAndRecreate` `secrets` parameter for why binding
   * the bag beats looking it up whenever the bag is in scope.
   *
   * Do NOT restate that the engine "already masked its own error text" — an
   * earlier revision of this comment did, and it was FALSE: `provisionResource`
   * logged the raw AWS message at `error` level (a HIGHER level than this
   * summary) until #2038's review round. Only the EVENT store was masked.
   */
  private maskingRetryLogger(logicalId: string): RetryLogger {
    return {
      debug: (msg) => this.logger.debug(maskForResource(this.secretsRun, logicalId, msg)),
      warn: (msg) => this.logger.warn(maskForResource(this.secretsRun, logicalId, msg)),
    };
  }

  /**
   * The EAGER `RetryLogger`, bound to the bag the caller actually resolved
   * with (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038)).
   *
   * Preferred over {@link maskingRetryLogger} wherever the resolution pass's
   * own `RecordedSecretValues` is in scope, for the reason
   * `replacement.ts`'s `replaceDeleteFirstAndRecreate` parameter list already states about
   * the masker it threads: a map looked up by logical id is a DIFFERENT thing
   * from the bag this call resolved with, and one file must not argue both
   * sides. It delegates to the shared `masking-retry-logger.ts` so the deploy
   * engine, `rollback-executor.ts` and `drift.ts` cannot drift apart.
   */
  /** @internal */
  maskingRetryLoggerFor(secrets: RecordedSecretValues): RetryLogger {
    return maskingRetryLogger(this.logger, secrets);
  }
}
