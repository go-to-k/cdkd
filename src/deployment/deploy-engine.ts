import { getLogger } from '../utils/logger.js';
import { timePhaseSync } from '../utils/phase-timings.js';
import { DeploymentEventsReader } from '../state/deployment-events-store.js';
import { loadRollbackRetainedCopies } from './kept-in-history.js';
import type { GeneratedNameGuard } from './generated-name-guard.js';
import { withStackScopeBeforeStateRead } from '../provisioning/resource-name.js';
import {
  ledgerForStack,
  withCreateTokenLedger,
} from '../provisioning/providers/create-token-ledger.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import {
  redactForState,
  scrubResourceRecord,
  maskSecretsInText,
  hasMaskableValues,
  isSameGenerationBag,
  redactionClaimOf,
  type ScrubGenerationClaims,
  type RecordedSecretValues,
} from './secret-redaction.js';
import { outputMapsEqual } from './deploy-value-equality.js';
import {
  KEEP_REFERENCE_PROVENANCE,
  outputProvenanceForPersist,
  provenanceForWrittenRecord,
  withReferenceProvenance,
} from './reference-provenance-record.js';
import { ProvenanceCapture } from './deploy-engine/provenance-capture.js';
import { ReplacementRunState, type ReplacementDeps } from './deploy-engine/replacement.js';
import {
  isWrittenFromDeployedTemplate,
  withMaskedPropertyFingerprints,
} from './masked-property-fingerprints.js';
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
  stackInstanceIdCarriedFrom,
} from '../types/state.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import type { LockManager } from '../state/lock-manager.js';
import type { ExportIndexStore } from '../state/export-index-store.js';
import type { DagBuilder } from '../analyzer/dag-builder.js';
import type { DiffCalculator } from '../analyzer/diff-calculator.js';
import { constructPathOf, withConstructPath } from '../analyzer/destructive-changes.js';
import { ProviderRegistry } from '../provisioning/provider-registry.js';
import { injectiveKey } from '../state/record-keys.js';
import {
  prefetchCreateOnlyPropertyPaths,
  templateResourceTypes,
} from '../provisioning/create-only-properties.js';
import { hasNoRegistrySchema } from '../provisioning/describe-type.js';
import { TemplateParser } from '../analyzer/template-parser.js';
import { withRetry, type RetryLogger } from './retry.js';
import { maskingRetryLogger } from './masking-retry-logger.js';
import { maskEventTextWithBoundBags, ORPHAN_COMMAND_LABEL } from './secret-name-needles.js';
import { withPrintingSecrets } from './resource-secrets-scope.js';
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
  allRecordedSecrets,
  absorbOutputsPassSecrets,
  maskForResource,
  maskedRecordRemedyFor,
  printingSecretsFor,
  readReaderForFreshNoEchoCeiling,
  redactOutputs,
  stateNamingSecrets,
  type MaskingDeps,
} from './deploy-engine/masking.js';
import { AttributeHealer } from './deploy-engine/attribute-healer.js';
import type { DeleteDeps } from './deploy-engine/delete.js';
import { doDeployWithPrefetch } from './deploy-engine/deploy-flow.js';
import { guardedReplacementCreate } from './deploy-engine/create.js';
import {
  buildResolverContext,
  type ResolverContextDeps,
} from './deploy-engine/resolver-context.js';
import {
  applyNoEchoPersist,
  NoEchoRunState,
  noEchoPositionSources,
  withNoEchoExactEchoes,
  type NoEchoDeps,
} from './deploy-engine/noecho.js';
import type { ProducerRegionEvidence } from './producer-regions-scope.js';
import {
  isSupersededHeldBySameType,
  isSupersededResourceRecord,
  withoutSuperseded,
} from './superseded-resources.js';
export {
  DEFAULT_RESOURCE_TIMEOUT_MS,
  DEFAULT_RESOURCE_WARN_AFTER_MS,
  type DeployEngineOptions,
  type DeployResult,
} from './deploy-engine/options.js';
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
  private inlinePolicyWriters = new Map<string, InlinePolicyWrite>();

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

  /**
   * A fresh {@link observedCapture} over this engine's deps, for the
   * constructor and `deploy()`'s per-run reset.
   * @internal
   */
  freshObservedCapture(): ObservedCapture {
    return new ObservedCapture({
      logger: this.logger,
      options: this.options,
      resolver: this.resolver,
      providerRegistry: this.providerRegistry,
      printingSecretsFor: (logicalId) => printingSecretsFor(this.secretsRun, logicalId),
      // Live: replaced mid-run by the schema-upgrade backfill (deploy-flow.ts).
      fingerprintNoEchoValues: () => this.secretsRun.fingerprintNoEchoValues,
      provenanceCapture: () => this.provenanceCapture,
    });
  }

  /**
   * Set {@link healBaseline}: a fresh {@link attributeHealer} over `resources`.
   * @internal
   */
  rebaseline(resources: Readonly<Record<string, ResourceState>>): AttributeHealer {
    this.attributeHealer = new AttributeHealer({
      providerRegistry: this.providerRegistry,
      stackRegion: this.stackRegion,
      logger: this.logger,
      baseline: resources,
      // Read at merge time: `secretsRun` is replaced per deploy.
      resolvedSecretsOf: (logicalId) => this.secretsRun.perResourceSecrets.get(logicalId),
      // Read at heal time: bound and captured after this rebaseline.
      namingSecrets: () => stateNamingSecrets(this.secretsRun),
    });
    return this.attributeHealer;
  }

  /**
   * A fresh {@link provenanceCapture} over this engine's current deps, for
   * the constructor and `deploy()`'s per-run reset — never a clear in place,
   * so a reused engine never serves a previous deploy's capture tasks.
   * @internal
   */
  freshProvenanceCapture(): ProvenanceCapture {
    return new ProvenanceCapture({
      buildResolverContext: (...args) => buildResolverContext(this.resolverContextDeps(), ...args),
      resolver: this.resolver,
      logger: this.logger,
    });
  }

  /**
   * This engine's current deps for `deploy-engine/outputs.ts`'s plain
   * functions, built fresh at each call site so a forwarded method
   * (`buildResolverContext`, `noEchoPositionSources`) stays bound to THIS
   * engine rather than a snapshot — the same arrow-forwarding
   * {@link freshProvenanceCapture} uses.
   * @internal
   */
  outputsDeps(): OutputsDeps {
    return {
      options: this.options,
      logger: this.logger,
      resolver: this.resolver,
      buildResolverContext: (...args) => buildResolverContext(this.resolverContextDeps(), ...args),
      noEchoPositionSources: (...args) => noEchoPositionSources(this.noEchoRun, ...args),
    };
  }

  /**
   * This engine's current deps for `deploy-engine/noecho.ts`'s plain
   * functions, built fresh at each call site like {@link outputsDeps}. The
   * per-deploy state `deploy()` REASSIGNS (`secretsRun`'s
   * `perResourceSecrets` / `perResourceTemplateProps` /
   * `perResourceResolvedType`, `outputsRun`) is read through live getters,
   * and a forwarded function stays bound to THIS engine.
   * @internal
   */
  noEchoDeps(): NoEchoDeps {
    return {
      stackRegion: this.stackRegion,
      logger: this.logger,
      providerRegistry: this.providerRegistry,
      perResourceSecrets: () => this.secretsRun.perResourceSecrets,
      perResourceTemplateProps: () => this.secretsRun.perResourceTemplateProps,
      perResourceResolvedType: () => this.secretsRun.perResourceResolvedType,
      outputsRun: () => this.outputsRun,
      readReaderForFreshNoEchoCeiling: (...args) =>
        readReaderForFreshNoEchoCeiling(this.maskingDeps(), ...args),
      maskForResource: (...args) => maskForResource(this.secretsRun, ...args),
    };
  }

  /**
   * This engine's current deps for `deploy-engine/masking.ts`'s plain
   * functions, built fresh at each call site like {@link noEchoDeps}.
   * `options` / `stackRegion` / `logger` / `providerRegistry` are never
   * reassigned after construction, so they are passed by value; `outputsRun`
   * and `noEchoRun` (replaced per `deploy()`) and
   * `noEchoCeilingReadbackTimeoutMs` (a field a test shortens) are live
   * getters, and `noEchoDeps` stays bound to THIS engine.
   * @internal
   */
  maskingDeps(): MaskingDeps {
    return {
      options: this.options,
      stackRegion: this.stackRegion,
      logger: this.logger,
      providerRegistry: this.providerRegistry,
      outputsRun: () => this.outputsRun,
      noEchoRun: () => this.noEchoRun,
      noEchoDeps: () => this.noEchoDeps(),
      noEchoCeilingReadbackTimeoutMs: () => this.noEchoCeilingReadbackTimeoutMs,
    };
  }

  /**
   * This engine's current deps for `deploy-engine/replacement.ts`'s plain
   * functions, built fresh at each call site like {@link maskingDeps}.
   * `options` / `stackRegion` / `logger` are never reassigned after
   * construction, so they are passed by value; `secretsRun` (replaced per
   * `deploy()`), `stackRecordsView` / `deployStateResources` (set by
   * `executeDeployment`) and `interrupted` / `interruptCause` (set mid-deploy)
   * are live getters, and the forwarded methods stay bound to THIS engine.
   * @internal
   */
  replacementDeps(): ReplacementDeps {
    return {
      options: this.options,
      stackRegion: this.stackRegion,
      logger: this.logger,
      secretsRun: () => this.secretsRun,
      stackRecordsView: () => this.stackRecordsView,
      deployStateResources: () => this.deployStateResources,
      interrupted: () => this.interrupted,
      interruptCause: () => this.interruptCause,
      userInterrupted: () => this.userInterrupted,
      withRetry: (...args) => this.withRetry(...args),
      maskingRetryLoggerFor: (...args) => this.maskingRetryLoggerFor(...args),
      inlinePolicyClaimedFor: (...args) => this.inlinePolicyClaimedFor(...args),
      recordEvent: (...args) => this.recordEvent(...args),
      guardedReplacementCreate: (input, create) => guardedReplacementCreate(this, input, create),
      generatedNameGuarded: (logicalId) =>
        this.generatedNameGuard?.candidate(logicalId) !== undefined,
      rollbackRetainedCopies: (stackName) => {
        const reader = new DeploymentEventsReader(this.stateBackend);
        return loadRollbackRetainedCopies(
          {
            listRuns: (s, r) => reader.listRuns(s, r),
            readRunEvents: (s, r, id) => reader.readRunEvents(s, r, id),
          },
          stackName,
          this.stackRegion
        );
      },
    };
  }

  /**
   * This engine's current deps for `deploy-engine/resolver-context.ts`'s
   * plain functions, built fresh at each call site like
   * {@link replacementDeps}. `options` / `stateBackend` / `exportIndexStore` /
   * `resolver` are set only in the constructor, so they are passed by value;
   * `secretsRun` / `noEchoRun` / `recordedImports` / `recordedOutputReads` /
   * `runProducerRegionEvidence` (replaced per `deploy()`, the last also set
   * mid-deploy) and `attributeHealer` / `healBaseline` (replaced by
   * {@link rebaseline}) are live getters, so a context's healer and
   * producer-secret closures read the CURRENT value when called.
   * @internal
   */
  resolverContextDeps(): ResolverContextDeps {
    return {
      options: this.options,
      stateBackend: this.stateBackend,
      exportIndexStore: this.exportIndexStore,
      resolver: this.resolver,
      secretsRun: () => this.secretsRun,
      noEchoRun: () => this.noEchoRun,
      healBaseline: () => this.healBaseline,
      attributeHealer: () => this.attributeHealer,
      recordedImports: () => this.recordedImports,
      recordedOutputReads: () => this.recordedOutputReads,
      runProducerRegionEvidence: () => this.runProducerRegionEvidence,
    };
  }

  /**
   * This engine's current deps for `deploy-engine/delete.ts`'s
   * `provisionDelete`, built fresh at each call site like
   * {@link replacementDeps}. `options` / `stateBackend` / `stackRegion` /
   * `logger` / `providerRegistry` are set only in the constructor, so they are
   * passed by value; `secretsRun` (replaced per `deploy()`) is a live getter,
   * `owner` is this engine's identity (the retained-readoption key), and the
   * forwarded methods stay bound to THIS engine.
   * @internal
   */
  deleteDeps(): DeleteDeps {
    return {
      owner: this,
      options: this.options,
      stateBackend: this.stateBackend,
      stackRegion: this.stackRegion,
      logger: this.logger,
      providerRegistry: this.providerRegistry,
      secretsRun: () => this.secretsRun,
      replacementDeps: () => this.replacementDeps(),
      withRetry: (...args) => this.withRetry(...args),
      inlinePolicyClaimedFor: (...args) => this.inlinePolicyClaimedFor(...args),
    };
  }

  /**
   * This engine's current deps for `deploy-engine/rollback.ts`'s plain
   * functions, built fresh at each call site like {@link deleteDeps}.
   * `options` / `stateBackend` / `lockManager` / `stackRegion` / `logger` /
   * `providerRegistry` are set only in the constructor, so they are passed by
   * value; `secretsRun` / `noEchoRun` / `outputsRun` / `recordedImports` /
   * `recordedOutputReads` / `resumedCreates` (replaced per `deploy()`, the last
   * also by the success settle) and `absentJournalVersionPurge` /
   * `interrupted` (set mid-deploy) are live getters, `owner` is this engine's
   * identity (the adopted-orphan records' key), and the forwarded methods stay
   * bound to THIS engine.
   * @internal
   */
  rollbackDeps(): RollbackDeps {
    return {
      owner: this,
      logger: this.logger,
      options: this.options,
      stackRegion: this.stackRegion,
      stateBackend: this.stateBackend,
      lockManager: this.lockManager,
      providerRegistry: this.providerRegistry,
      secretsRun: () => this.secretsRun,
      noEchoRun: () => this.noEchoRun,
      outputsRun: () => this.outputsRun,
      recordedImports: () => this.recordedImports,
      recordedOutputReads: () => this.recordedOutputReads,
      resumedCreates: () => this.resumedCreates,
      resetResumedCreates: () => {
        this.resumedCreates = new Map();
      },
      absentJournalVersionPurge: () => this.absentJournalVersionPurge,
      interrupted: () => this.interrupted,
      userInterrupted: () => this.userInterrupted,
      noEchoDeps: () => this.noEchoDeps(),
      recordEvent: (...args) => this.recordEvent(...args),
      crossStackReadKeyNormalizer: (...args) => this.crossStackReadKeyNormalizer(...args),
    };
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
    // Replaces all ten secret-masking / fingerprint fields at once
    // (`SecretsRunState`). `perResourceResolvedType` is reset with its
    // siblings (issue #2934). Inert today — a stale TRUE pairs with cleared
    // needle maps and reduces to the identity fallback — but that map's whole
    // job is to answer "do those needles describe THIS record", and a reused
    // engine carrying last deploy's answer is the #2516 class.
    this.secretsRun = new SecretsRunState();
    // Replaces all ten `NoEcho` positional-arm fields at once (`NoEchoRunState`).
    this.noEchoRun = new NoEchoRunState();
    // Replaces all ten replacement-bookkeeping fields at once
    // (`ReplacementRunState`). Issue #2603: an engine can be reused across
    // deploys, and a STALE `true` in `retainedOldOnReplacement` would tell the
    // next run's rollback to re-adopt an id this run deleted. Reset in the
    // same block as the other per-run bags.
    this.replacementRun = new ReplacementRunState();
    // Issue #2516: reset with the other per-deploy maps. A reused engine
    // whose next deploy fails before its own attempted bag is recorded would
    // otherwise journal the PREVIOUS run's bag against today's template and
    // pairs — and now mark it as today's.
    this.attemptedResolvedProps = new Map();
    this.unsettledMarks = new Map();
    this.resumedCreates = new Map();
    this.generatedNameGuard = undefined;
    this.liveTaskLabels = new Map();
    // Replaces all ten Outputs-pass fields at once (`OutputsRunState`): the
    // per-deploy reset. `resolvedExportNames` and `carriedExportAliasRefusal`
    // are ALSO reset per PASS at the top of `resolveOutputs`, since they
    // describe the last pass, not the deploy. In
    // particular `skippedOutputs` (issue #2740, same reuse hazard as
    // `replacementRun.retainedOldOnReplacement` above: `resolveOutputs` recomputes it at the
    // END of a pass but early-returns for a template with no `Outputs`
    // without touching it) and `outputsTemplateSource` (issue #1943's class /
    // #2740's `__proto__` case: null-prototype, keyed by TEMPLATE-CONTROLLED
    // output names, same as the bag it positions).
    this.outputsRun = new OutputsRunState();
    this.provenanceBaseline = undefined;
    this.provenanceCapture = this.freshProvenanceCapture();
    this.observedCapture = this.freshObservedCapture();
    // Issue #1852: per-deploy, like every bag above — a reused engine must not
    // serve last deploy's read, nor persist it against today's records.
    this.rebaseline({});
    this.runProducerRegionEvidence = undefined;
    this.deployChanges = new Map();
    this.deployStateResources = {};
    this.inlinePolicyWriters = new Map();
    // Per-deploy-run counter: the resolver instance is engine-scoped and an
    // engine can be reused across deploys, so reset here (not in the
    // resolver constructor) to keep the deploy-summary count per run.
    this.resolver.resetPhysicalIdFallbackCount();
    // Scope `stackName` to this deploy's async chain so concurrent
    // deploys (--stack-concurrency > 1) don't see each other's value.
    // See `src/provisioning/resource-name.ts` for the AsyncLocalStorage
    // background. go-to-k/cdkd#5064: the stack's instance id is in its state
    // record, which `doDeployWithPrefetch` reads under the lock and then opens
    // the id-bearing `withStackScope` for everything that names a resource;
    // until then a generated name is refused rather than derived without it.
    // go-to-k/cdkd#4438: the stack's create-token ledger, which the EFS, FSx
    // and CloudFront OAI providers fold into their lifetime-bound create
    // tokens (`src/provisioning/providers/create-token-ledger.ts`).
    const ledger = ledgerForStack(this.stateBackend, stackName, this.stackRegion);
    return withStackScopeBeforeStateRead(stackName, () =>
      this.options.dryRun
        ? this.doDeploy(stackName, template)
        : withCreateTokenLedger(ledger, () => this.doDeploy(stackName, template))
    );
  }

  /** @internal Body in `deploy-engine/masking.ts` (#4200). */
  static maskedRecordRemedyFor = maskedRecordRemedyFor;

  private redactStateForPersist(state: StackState): StackState {
    const resources: Record<string, ResourceState> = {};
    for (const [logicalId, record] of Object.entries(state.resources)) {
      // Redact each record ONLY with the secrets substituted during that
      // resource's own resolution — see the `SecretsRunState.perResourceSecrets` doc.
      const secrets = this.secretsRun.perResourceSecrets.get(logicalId);
      // The template bag is the POSITION source (#1904); when this resource was
      // not resolved this deploy there is none, and `scrubResourceRecord` falls
      // back to the record's own `properties` for the observed bag (#1900).
      const templateProps = this.secretsRun.perResourceTemplateProps.get(logicalId);
      // Issue #1852: merged BEFORE the scrub, so a healed value enters the
      // same pass a provider-recorded attribute does. That pass has no needles
      // for an UNCHANGED record (nothing resolved for it this deploy), so what
      // keeps a sensitive value out is the read itself: masked keys are
      // dropped in `readRecordAttributes`, and custom resources / nested stacks
      // are never read.
      const healed = this.attributeHealer.withHealedAttributes(logicalId, record);
      const scrubbed = scrubResourceRecord(
        healed,
        secrets ?? new Map<string, string>(),
        // No template bag means this resource was not resolved this deploy (an
        // UNCHANGED one). `scrubResourceRecord` then falls back to the record's
        // own already-redacted properties as the observed bag's source, which is
        // the #1900 path — so do NOT "simplify" this to `templateProps!`.
        templateProps,
        undefined,
        // go-to-k/cdkd#5047: the walk reads no mark, so the claims the record's
        // bags carry (`propertiesToRecord`, `drainObservedCaptures`) are stated
        // here, off the very objects those producers installed.
        sameGenerationClaimsOf(healed)
      );
      // go-to-k/cdkd#4451: the masked properties' template fingerprints, read
      // off the SCRUBBED bag (only it holds `***`), and rebuilt only for a
      // record this deploy wrote; a failed update keeps the previous bag and
      // its previous fingerprints. This resource's needles refuse a hash to a
      // template value that holds one as a literal.
      // go-to-k/cdkd#4043 / #2449: the `NoEcho` arms, BEFORE the fingerprints,
      // which read the `***` keys of the persisted bag.
      const noEchoScrubbed = applyNoEchoPersist(
        this.noEchoRun,
        this.noEchoDeps(),
        logicalId,
        record,
        // go-to-k/cdkd#4656: this deploy's echo-fidelity verdicts join the
        // record's own; only this loop's records are the ones it read back.
        withNoEchoExactEchoes(this.noEchoRun, logicalId, scrubbed),
        templateProps,
        state.resources,
        secrets
      );
      resources[logicalId] = withReferenceProvenance(
        withConstructPath(
          withMaskedPropertyFingerprints(
            noEchoScrubbed,
            record.properties,
            templateProps,
            secrets,
            this.secretsRun.fingerprintNoEchoValues,
            this.secretsRun.perResourceInputFingerprints.get(logicalId)
          ),
          constructPathOf(this.noEchoRun.constructPathTemplate, logicalId)
        ),
        this.referenceProvenanceToPersist(logicalId, record, noEchoScrubbed, secrets)
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
    const orphanEntries = state.orphans;
    // go-to-k/cdkd#5111: shared with `supersededResources` below.
    const scrubDroppedRecord = (entry: {
      logicalId: string;
      state: ResourceState;
    }): ResourceState => {
      // Did THIS deploy resolve that logical id, as that same TYPE? Only then
      // do the needles describe this record.
      //
      // Keyed on what the deploy RESOLVED, not on `state.resources`: an orphan
      // is by definition absent from `resources`, so that spelling read false
      // for the record being MINTED — the needles went empty and the plaintext
      // survived. Measured by `tests/integration/retain-orphan-secret`.
      const sameResource =
        this.secretsRun.perResourceResolvedType.get(entry.logicalId) === entry.state.resourceType;
      const orphanTemplateProps = sameResource
        ? this.secretsRun.perResourceTemplateProps.get(entry.logicalId)
        : undefined;
      return (
        // go-to-k/cdkd#4451: a record THIS deploy created and its rollback
        // orphaned carries a bag this deploy wrote, so it gets its masked
        // properties' fingerprints here too, or a later adoption backfills
        // them from whatever template that deploy carries.
        withMaskedPropertyFingerprints(
          // go-to-k/cdkd#4043 (review M4): the `NoEcho` arms too, positioned
          // by today's template while it still names the logical id as that
          // type.
          applyNoEchoPersist(
            this.noEchoRun,
            this.noEchoDeps(),
            entry.logicalId,
            entry.state,
            scrubResourceRecord(
              entry.state,
              (sameResource
                ? this.secretsRun.perResourceSecrets.get(entry.logicalId)
                : undefined) ?? new Map<string, string>(),
              orphanTemplateProps,
              undefined,
              sameGenerationClaimsOf(entry.state)
            ),
            orphanTemplateProps,
            state.resources
          ),
          entry.state.properties,
          orphanTemplateProps,
          sameResource ? this.secretsRun.perResourceSecrets.get(entry.logicalId) : undefined,
          sameResource ? this.secretsRun.fingerprintNoEchoValues : undefined,
          sameResource
            ? this.secretsRun.perResourceInputFingerprints.get(entry.logicalId)
            : undefined
        )
      );
    };
    const orphans = orphanEntries?.map((entry) => ({ ...entry, state: scrubDroppedRecord(entry) }));
    // go-to-k/cdkd#5111: a superseded resource's record is secret-bearing in
    // exactly the way an orphan's is, and scrubbed the same way. One a record
    // holds again (a rollback took it back) is not persisted: it is no longer
    // superseded, and a later deploy must not delete it.
    const superseded = Array.isArray(state.supersededResources)
      ? state.supersededResources.flatMap((entry) => {
          // A malformed entry is the reader's to skip, never this writer's to drop.
          if (!isSupersededResourceRecord(entry)) return [entry];
          if (isSupersededHeldBySameType(entry, state.resources)) return [];
          return [{ ...entry, state: scrubDroppedRecord(entry) }];
        })
      : undefined;
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
    const outputs = redactOutputs(this.maskingDeps(), state.outputs);
    const crossStackReads = this.redactCrossStackReads(state);
    // State schema v12: written from the bag this save persists, per key.
    const {
      outputReferenceProvenance: _incoming,
      supersededResources: _superseded,
      ...rest
    } = state;
    // go-to-k/cdkd#5111: written below from the filtered set only.
    const outputReferenceProvenance = this.outputReferenceProvenanceFor(state.outputs, outputs);
    return {
      ...rest,
      // go-to-k/cdkd#5111: `supersededResources` is written below, filtered.
      ...stackInstanceIdCarriedFrom(withoutSuperseded(state)),
      resources,
      outputs,
      ...(orphans === undefined ? {} : { orphans }),
      // A malformed (non-array) field is carried verbatim, never dropped here.
      ...(superseded === undefined
        ? _superseded !== undefined && { supersededResources: _superseded }
        : superseded.length > 0 && { supersededResources: superseded }),
      ...crossStackReads,
      ...(outputReferenceProvenance !== undefined && { outputReferenceProvenance }),
    };
  }

  /**
   * State schema v12 (go-to-k/cdkd#4847 / #4852): the
   * `outputReferenceProvenance` a save persists beside `outputs` (the bag as
   * the save holds it) / `redacted` (as it will persist):
   *
   * - a bag this deploy resolved: per key, from that output's own sink;
   * - the loaded record's bag, carried: its field verbatim, or, when the
   *   record has none (written before v12) and this deploy resolved an EQUAL
   *   bag, that resolution's (the outputs' share of the migration);
   * - anything else (a merge): none.
   */
  /** @internal */
  outputReferenceProvenanceFor(
    outputs: Record<string, unknown>,
    redacted: Record<string, unknown>
  ): Record<string, Record<string, ReferenceProvenance>> | undefined {
    const sinkOf = (outputKey: string): RecordedSecretValues | undefined =>
      this.outputsRun.outputProvenanceSinks.get(outputKey);
    const baseline = this.provenanceBaseline;
    if (
      !this.outputsRun.outputsResolvedThisRun.has(outputs) &&
      baseline !== undefined &&
      outputs === baseline.outputs &&
      baseline.outputReferenceProvenance === undefined &&
      !baseline.tokenFree &&
      this.outputsRun.resolvedOutputsBag !== undefined &&
      outputMapsEqual(
        redactOutputs(this.maskingDeps(), this.outputsRun.resolvedOutputsBag),
        redacted
      )
    ) {
      return outputProvenanceForPersist({
        outputs: redacted,
        resolvedThisRun: true,
        carriedFrom: undefined,
        sinkOf,
      });
    }
    return outputProvenanceForPersist({
      outputs: redacted,
      resolvedThisRun: this.outputsRun.outputsResolvedThisRun.has(outputs),
      carriedFrom: baseline !== undefined && outputs === baseline.outputs ? baseline : undefined,
      sinkOf,
    });
  }

  /**
   * State schema v12 (go-to-k/cdkd#4847 / #4852): the `referenceProvenance`
   * one record persists. A record this deploy WROTE (its `properties` bag is
   * marked same-generation, or written from this deploy's template through a
   * provider's `effectiveProperties`) takes this pass's entries for the tokens its
   * scrubbed form holds; an in-place update keeps every generation a
   * create-only path may still hold. A record it did NOT write keeps its
   * field verbatim and is never walked: `perResourceSecrets` is filled before
   * an update's skip return and never cleared, so without the gate a skipped
   * record would take versions it was never sent.
   *
   * Returns `KEEP` for "leave the record's own field as it is".
   */
  private referenceProvenanceToPersist(
    logicalId: string,
    record: ResourceState,
    scrubbed: ResourceState,
    secrets: RecordedSecretValues | undefined
  ): Record<string, ReferenceProvenance> | undefined | typeof KEEP_REFERENCE_PROVENANCE {
    // A provider's `effectiveProperties` replacement is written too
    // (`isWrittenFromDeployedTemplate`) but is not same-generation: it may
    // carry the previous record's leaves, so on an in-place update every
    // token takes the union rule.
    const sameGeneration = isSameGenerationBag(record.properties);
    if (!sameGeneration && !isWrittenFromDeployedTemplate(record.properties)) {
      return KEEP_REFERENCE_PROVENANCE;
    }
    const previous = Object.hasOwn(this.healBaseline, logicalId)
      ? this.healBaseline[logicalId]
      : undefined;
    // An update whose provider sent NOTHING (Cloud Control's empty patch,
    // go-to-k/cdkd#4443) left AWS as the previous record describes it.
    if (this.replacementRun.updatesThatSentNothing.has(logicalId) && previous !== undefined) {
      return previous.referenceProvenance;
    }
    // `update-in-place.ts` records the paths for every in-place write that
    // holds pass provenance or a previous field, the only writes that reach
    // the union; `'all'` is the conservative answer for any other.
    const createOnly = sameGeneration
      ? this.replacementRun.inPlaceCreateOnlyPaths.get(logicalId)
      : 'all';
    const inPlace =
      this.replacementRun.updateWasReplaced.get(logicalId) === false && previous !== undefined
        ? {
            createOnly: createOnly ?? ('all' as const),
            attributesCarried:
              record.attributes !== undefined && record.attributes === previous.attributes,
          }
        : undefined;
    return provenanceForWrittenRecord({
      record: scrubbed,
      secrets,
      previous,
      inPlace,
      // A stack loaded off the token-free fast path walks a record only when
      // this pass recorded provenance for it.
      walkWithoutPassProvenance: this.provenanceBaseline?.tokenFree !== true,
    });
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
    const secrets = allRecordedSecrets(this.secretsRun, this.maskingDeps());
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
    const redact = (value: string): string =>
      redactForState(value, { provenance: 'value-scan', secrets: secrets });
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
    absorbOutputsPassSecrets(this.maskingDeps());
    const secrets = allRecordedSecrets(this.secretsRun, this.maskingDeps());
    if (secrets.size === 0) return (name) => name;
    return (name) => redactForState(name, { provenance: 'value-scan', secrets: secrets });
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
  /** @internal */
  withParentInfo(state: StackState): StackState {
    // go-to-k/cdkd#5200: CPU on the event loop, once per save.
    const redacted = timePhaseSync('state saves (every stack)', 'redact for persist', () =>
      this.redactStateForPersist(state)
    );
    if (!this.options.parentStackInfo) return redacted;
    const { parentStack, parentLogicalId, parentRegion } = this.options.parentStackInfo;
    return {
      ...redacted,
      ...stackInstanceIdCarriedFrom(redacted),
      parentStack,
      parentLogicalId,
      parentRegion,
    };
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
      return await doDeployWithPrefetch(this, stackName, template, createOnlyPrefetch);
    } finally {
      createOnlyPrefetch.cancel();
    }
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
   *
   * ONE pass over the union of match spans of the event's own resource
   * secrets AND the printing bags bound where it is recorded
   * (go-to-k/cdkd#3869): two passes in either order let a needle of one bag
   * split an overlapping needle of the other and leave a fragment of it. A replay refusal's own
   * `To orphan it:` command line (`ownLines`) is exempt from the BOUND bags
   * only, as `maskEventTextWithBoundBags` documents; the engine bag still
   * masks it, as it always has.
   */
  private maskSecretsInEvent<
    T extends {
      logicalId?: string;
      error?: { message?: string; ownLines?: boolean };
      reason?: string;
    },
  >(event: T): T {
    // Mask with the event's own resource secrets; a resource-less (run-level)
    // event carries no properties-derived text.
    // `printingSecretsFor`: a resource named from a secret also masks its
    // physical-id needles here (go-to-k/cdkd#3869). The event's `physicalId`
    // FIELD is left as is: it is the id a cleanup pass needs, and `state.json`
    // beside this store records it too.
    const own = event.logicalId ? printingSecretsFor(this.secretsRun, event.logicalId) : undefined;
    if (own === undefined || !hasMaskableValues(own)) return maskEventTextWithBoundBags(event);
    const masked = withPrintingSecrets(own, () => maskEventTextWithBoundBags(event));
    const message = masked.error?.message;
    if (masked.error?.ownLines !== true || !message) return masked;
    const commandLines = message
      .split('\n')
      .map((line) => (line.startsWith(ORPHAN_COMMAND_LABEL) ? maskSecretsInText(line, own) : line))
      .join('\n');
    return { ...masked, error: { ...masked.error, message: commandLines } };
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

/**
 * What the deploy engine's producer marks say about a record's two walked
 * bags, as {@link scrubResourceRecord}'s explicit claims (go-to-k/cdkd#5047).
 */
function sameGenerationClaimsOf(record: ResourceState): ScrubGenerationClaims {
  return {
    // A provider's leaf-certified `effectiveProperties` too (go-to-k/cdkd#5063).
    properties: redactionClaimOf(record.properties),
    observed: isSameGenerationBag(record.observedProperties) ? 'same-generation' : 'unproven',
  };
}
