import { getLogger } from '../utils/logger.js';
import type { GeneratedNameGuard } from './generated-name-guard.js';
import { withStackName } from '../provisioning/resource-name.js';
import {
  ledgerForStack,
  withCreateTokenLedger,
} from '../provisioning/providers/create-token-ledger.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import { type StaleAttributeHealOutcome } from './stale-attribute-heal.js';
import {
  redactSecretsForState,
  scrubResourceRecord,
  maskSecretsInText,
  hasMaskableValues,
  type RecordedSecretValues,
} from './secret-redaction.js';
import {
  type ChildTemplateLoader,
  type parameterInputsFor,
  withMaskedPropertyFingerprints,
} from './masked-property-fingerprints.js';
import {
  isInlinePolicyClaimedByCompletedWriter,
  type InlinePolicyWrite,
} from './inline-policy-claims.js';
import type { StackRecordsView } from './stack-records-scope.js';
import type {
  CloudFormationTemplate,
  InlinePolicyClaimed,
  ResourceProvider,
} from '../types/resource.js';
import {
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
import * as nameCollisionMixin from './deploy-engine/name-collision.js';
import * as outputsMixin from './deploy-engine/outputs.js';
import * as rollbackMixin from './deploy-engine/rollback.js';
import * as observedCaptureMixin from './deploy-engine/observed-capture.js';
import * as maskingMixin from './deploy-engine/masking.js';
import * as replacementMixin from './deploy-engine/replacement.js';
import * as healMixin from './deploy-engine/heal.js';
import * as createMixin from './deploy-engine/create.js';
import * as updateMixin from './deploy-engine/update.js';
import * as updateReplaceMixin from './deploy-engine/update-replace.js';
import * as updateInPlaceMixin from './deploy-engine/update-in-place.js';
import * as deleteMixin from './deploy-engine/delete.js';
import * as provisionMixin from './deploy-engine/provision.js';
import * as executeMixin from './deploy-engine/execute.js';
import * as deployFlowMixin from './deploy-engine/deploy-flow.js';
import * as resolverContextMixin from './deploy-engine/resolver-context.js';
import * as routingMixin from './deploy-engine/routing.js';
import * as recordShapeMixin from './deploy-engine/record-shape.js';
import * as dependenciesMixin from './deploy-engine/dependencies.js';
import * as noEchoMixin from './deploy-engine/noecho.js';
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
   * go-to-k/cdkd#2449: the attributes each record of the PREVIOUS state
   * declared `NoEcho` (`ResourceState.noEchoAttributeNames`), seeded at deploy
   * start. Read-only evidence for the positional arm and the refusal's
   * wording; never a source of needles (its values are the mask).
   */
  /** @internal */
  persistedNoEchoAttributes = new Map<string, ReadonlySet<string>>();
  /**
   * go-to-k/cdkd#4043: the condition verdicts of the deploy in progress, so the
   * positional arm opens only the `Fn::If` branch the deploy selected.
   */
  /** @internal */
  noEchoConditions: Record<string, boolean> | undefined;
  /**
   * go-to-k/cdkd#4043 (review round 9): a NESTED child's parameters whose value
   * carries a `NoEcho` value its parent supplied. The child template declares
   * them plain, so they are positioned as `NoEcho` parameters here: every
   * surface the top level masks by position (records, `noEchoLeaves`,
   * outputs, the journal, the custom-resource delete skip) covers the child.
   */
  /** @internal */
  inheritedNoEchoParameters: ReadonlySet<string> = new Set();
  /** @internal */
  noEchoPhysicalIdWarned = new Set<string>();
  /**
   * go-to-k/cdkd#4043 §3.3: per resource resolved this deploy, the canonical
   * JSON of each leaf a `NoEcho` PARAMETER served it, so a HELD producer's
   * echoed attribute can be matched against a value it was given without a
   * needle (a `Number`, a value under the floor). Never persisted.
   */
  /** @internal */
  noEchoPositionedValues = new Map<string, Set<string>>();
  /**
   * go-to-k/cdkd#4656: per resource, the `NoEcho` parameter coordinates a
   * readback of THIS deploy proved its provider echoes exactly, bound to the
   * physical id that readback judged, unioned into
   * `noEchoExactEchoLeaves` at the save (`withNoEchoExactEchoes`). Coordinates
   * only, never a value.
   */
  /** @internal */
  noEchoExactEchoes = new Map<string, { physicalId: string; coordinates: string[][] }>();
  /** @internal */
  noEchoAttributeReads = new Map<string, Promise<Record<string, unknown> | undefined>>();
  /**
   * go-to-k/cdkd#4043 (review MEDIUM-3): per logical id, why a create-first
   * replacement's delete of the OLD resource was skipped (its delete address
   * is a redacted `***`, or a provider otherwise declined), leaving it alive
   * and untracked. `provisionResource` turns it into the row's
   * `updatePartial`, so the deploy exits 2 like any survivor
   * (`--allow-unaddressed` opts out).
   */
  /** @internal */
  replacedDeleteSkips = new Map<string, string>();
  /**
   * The deploy-wide DERIVED-NAME registry (go-to-k/cdkd#3869): per logical
   * id, an EMPTY map whose LOG-ONLY needles are what its physical ids print as
   * when its name came from a secret (`noteSecretNamedRecord` in
   * `deploy-engine/masking.ts`). The resource's own printed lines mask with it
   * (`printingSecretsFor`, and the printing bag `provisionResource` binds),
   * and a resource reading it through `Ref` / `Fn::GetAtt` records its needles,
   * with the value it read, as LOG-ONLY needles of its own bag. Never
   * persisted. Reset per `deploy()`, like `perResourceSecrets`.
   */
  /** @internal */
  secretNameNeedles = new Map<string, RecordedSecretValues>();
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
   * The stack's `NoEcho` parameter values, set once parameters resolve
   * (go-to-k/cdkd#4451): a masked property whose template text holds one is
   * refused a fingerprint at the save. Reset per `deploy()`.
   */
  /** @internal */
  fingerprintNoEchoValues: RecordedSecretValues | undefined = undefined;
  /**
   * How each template parameter enters a masked property's INPUT fingerprint
   * (go-to-k/cdkd#4543), set once parameters resolve, so the diff pass and the
   * provisioning arms classify every parameter alike. Reset per `deploy()`.
   */
  /** @internal */
  fingerprintParameters: ReturnType<typeof parameterInputsFor> | undefined = undefined;
  /**
   * The nested-stack templates of the cloud assembly this deploy reads
   * (go-to-k/cdkd#4565), so a masked property reading a clean nested-stack
   * output is resolved alike in the diff pass and the provisioning arms. Set
   * with {@link fingerprintParameters}; reset per `deploy()`.
   */
  /** @internal */
  fingerprintChildTemplates: ChildTemplateLoader | undefined = undefined;
  /**
   * The input fingerprints (layout 2) each resource's masked properties
   * resolved to when this deploy provisioned it (go-to-k/cdkd#4543): what the
   * save stamps on a record this deploy wrote. Reset per `deploy()`.
   */
  /** @internal */
  perResourceInputFingerprints = new Map<string, Record<string, string>>();
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
   * The last `resolveOutputs` pass's verdict over an export alias the
   * no-change merge would CARRY from state rather than resolve
   * (go-to-k/cdkd#4657): the refusal warning, or `undefined` to carry it.
   * Same lifetime rule as `resolvedExportNames`; `undefined` until a
   * `resolveOutputs` pass has run (with or without `Outputs`: a pass with
   * none decides from the `NoEcho` seed alone, go-to-k/cdkd#4043 Phase C).
   */
  /** @internal */
  carriedExportAliasRefusal:
    | ((outputKey: string, exportName: string) => string | undefined)
    | undefined;
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
   * The condition-pruned template of the deploy in progress, read by
   * `redactStateForPersist` to stamp each record's `constructPath` on every
   * save. `undefined` until the template is pruned; reset per deploy.
   */
  /** @internal */
  constructPathTemplate: CloudFormationTemplate | undefined;
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
   * go-to-k/cdkd#4411: logical ids this deploy destroyed and re-created under
   * the SAME physical id (a fixed-name recreate, a delete-first `--replace`).
   * What AWS stored inside the old resource went with it, so the UPDATE arm
   * re-creates such a child (`child-of-recreated-parent.ts`) rather than
   * skipping it as unchanged. Cleared per `deploy()`.
   */
  /** @internal */
  recreatedUnderSameId = new Set<string>();

  /**
   * go-to-k/cdkd#4443: the children of a `recreatedUnderSameId` parent whose
   * re-create / re-put completed in this deploy. A failed deploy forgets the
   * state record of every OTHER such child (it is gone from AWS), so the next
   * deploy creates it. Cleared per `deploy()`.
   */
  /** @internal */
  restoredLostChildren = new Set<string>();

  /**
   * go-to-k/cdkd#4443: logical ids whose provider update reported it sent
   * NOTHING (`sentNothing`, Cloud Control's empty patch). A lost `reput` child
   * among them restored nothing, so a failed deploy treats it as unwritten
   * even though its operation completed, or threw afterwards. Cleared per
   * `deploy()`.
   */
  /** @internal */
  updatesThatSentNothing = new Set<string>();

  /**
   * go-to-k/cdkd#4615: the provider's `wasReplaced` answer for each UPDATE
   * that ran through a provider `update()`, journaled on its completed op. An
   * in-place update may still change the physical id (an SQS QueuePolicy's is
   * its first queue), and only this answer tells the rollback to revert it in
   * place instead of re-creating the old one and deleting the "new" one.
   * Cleared per `deploy()`.
   */
  /** @internal */
  updateWasReplaced = new Map<string, boolean>();

  /**
   * go-to-k/cdkd#4604: logical ids whose replacement deleted (or found gone)
   * the old resource BEFORE its create ran. A replacement orphan journaled for
   * one says so, so a rollback warns that the old resource is gone instead of
   * settling the failed UPDATE as a no-op. Cleared per `deploy()`.
   */
  /** @internal */
  oldDeletedBeforeCreate = new Set<string>();

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
  /** @internal */
  deployChanges: ReadonlyMap<string, ResourceChange> = new Map();
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
    this.persistedNoEchoAttributes = new Map();
    this.noEchoConditions = undefined;
    this.inheritedNoEchoParameters = new Set();
    this.noEchoPhysicalIdWarned = new Set();
    this.noEchoPositionedValues = new Map();
    this.noEchoExactEchoes = new Map();
    this.noEchoAttributeReads = new Map();
    this.replacedDeleteSkips = new Map();
    this.secretNameNeedles = new Map();
    this.perResourceTemplateProps = new Map();
    this.constructPathTemplate = undefined;
    // Reset with its siblings (issue #2934). Inert today — a stale TRUE pairs
    // with cleared needle maps and reduces to the identity fallback — but this
    // map's whole job is to answer "do those needles describe THIS record",
    // and a reused engine carrying last deploy's answer is the #2516 class.
    this.perResourceResolvedType = new Map();
    this.fingerprintNoEchoValues = undefined;
    this.fingerprintParameters = undefined;
    this.fingerprintChildTemplates = undefined;
    this.perResourceInputFingerprints = new Map();
    // Issue #2516: reset with the other per-deploy maps. A reused engine
    // whose next deploy fails before its own attempted bag is recorded would
    // otherwise journal the PREVIOUS run's bag against today's template and
    // pairs — and now mark it as today's.
    this.attemptedResolvedProps = new Map();
    this.generatedNameGuard = undefined;
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
    this.recreatedUnderSameId = new Set();
    this.restoredLostChildren = new Set();
    this.updatesThatSentNothing = new Set();
    this.updateWasReplaced = new Map();
    this.oldDeletedBeforeCreate = new Set();
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
    // go-to-k/cdkd#4438: the stack's create-token ledger, which the EFS, FSx
    // and CloudFront OAI providers fold into their lifetime-bound create
    // tokens (`src/provisioning/providers/create-token-ledger.ts`).
    const ledger = ledgerForStack(this.stateBackend, stackName, this.stackRegion);
    return withStackName(stackName, () =>
      this.options.dryRun
        ? this.doDeploy(stackName, template)
        : withCreateTokenLedger(ledger, () => this.doDeploy(stackName, template))
    );
  }

  /** @internal Body in `deploy-engine/masking.ts` (#4200). */
  static maskedRecordRemedyFor = maskingMixin.maskedRecordRemedyFor;

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
      const scrubbed = scrubResourceRecord(
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
      // go-to-k/cdkd#4451: the masked properties' template fingerprints, read
      // off the SCRUBBED bag (only it holds `***`), and rebuilt only for a
      // record this deploy wrote; a failed update keeps the previous bag and
      // its previous fingerprints. This resource's needles refuse a hash to a
      // template value that holds one as a literal.
      // go-to-k/cdkd#4043 / #2449: the `NoEcho` arms, BEFORE the fingerprints,
      // which read the `***` keys of the persisted bag.
      const noEchoScrubbed = this.applyNoEchoPersist(
        logicalId,
        record,
        // go-to-k/cdkd#4656: this deploy's echo-fidelity verdicts join the
        // record's own; only this loop's records are the ones it read back.
        this.withNoEchoExactEchoes(logicalId, scrubbed),
        templateProps,
        state.resources,
        secrets
      );
      resources[logicalId] = withConstructPath(
        withMaskedPropertyFingerprints(
          noEchoScrubbed,
          record.properties,
          templateProps,
          secrets,
          this.fingerprintNoEchoValues,
          this.perResourceInputFingerprints.get(logicalId)
        ),
        constructPathOf(this.constructPathTemplate, logicalId)
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
      const orphanTemplateProps = sameResource
        ? this.perResourceTemplateProps.get(entry.logicalId)
        : undefined;
      return {
        ...entry,
        // go-to-k/cdkd#4451: a record THIS deploy created and its rollback
        // orphaned carries a bag this deploy wrote, so it gets its masked
        // properties' fingerprints here too, or a later adoption backfills
        // them from whatever template that deploy carries.
        state: withMaskedPropertyFingerprints(
          // go-to-k/cdkd#4043 (review M4): the `NoEcho` arms too, positioned
          // by today's template while it still names the logical id as that
          // type.
          this.applyNoEchoPersist(
            entry.logicalId,
            entry.state,
            scrubResourceRecord(
              entry.state,
              (sameResource ? this.perResourceSecrets.get(entry.logicalId) : undefined) ??
                new Map<string, string>(),
              orphanTemplateProps
            ),
            orphanTemplateProps,
            state.resources
          ),
          entry.state.properties,
          orphanTemplateProps,
          sameResource ? this.perResourceSecrets.get(entry.logicalId) : undefined,
          sameResource ? this.fingerprintNoEchoValues : undefined,
          sameResource ? this.perResourceInputFingerprints.get(entry.logicalId) : undefined
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
   * go-to-k/cdkd#4156: the live predicate handed to an `AWS::IAM::Policy`
   * update or delete, so it does not remove a name another resource of this
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
      return await this.doDeployWithPrefetch(stackName, template, createOnlyPrefetch);
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
    const own = event.logicalId ? this.printingSecretsFor(event.logicalId) : undefined;
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
  /** @internal */
  maskingRetryLoggerFor(secrets: RecordedSecretValues): RetryLogger {
    return maskingRetryLogger(this.logger, secrets);
  }
}

DeployEngine.prototype.hasPending = dependenciesMixin.hasPending;
DeployEngine.prototype.buildDeletionDependencies = dependenciesMixin.buildDeletionDependencies;
DeployEngine.prototype.addImplicitDeleteDependencies =
  dependenciesMixin.addImplicitDeleteDependencies;

DeployEngine.prototype.auditResolvedAssetReferences = recordShapeMixin.auditResolvedAssetReferences;
DeployEngine.prototype.extractAllDependencies = recordShapeMixin.extractAllDependencies;
DeployEngine.prototype.propertiesToRecord = recordShapeMixin.propertiesToRecord;
DeployEngine.prototype.extractTemplateAttributes = recordShapeMixin.extractTemplateAttributes;

DeployEngine.prototype.isPinnedToCcApi = routingMixin.isPinnedToCcApi;
DeployEngine.prototype.recreateDirectionFor = routingMixin.recreateDirectionFor;
DeployEngine.prototype.peekRoutingForLabel = routingMixin.peekRoutingForLabel;
DeployEngine.prototype.preparePropertiesForCcApi = routingMixin.preparePropertiesForCcApi;

DeployEngine.prototype.buildResolverContext = resolverContextMixin.buildResolverContext;
DeployEngine.prototype.maskedInputSources = resolverContextMixin.maskedInputSources;

DeployEngine.prototype.doDeployWithPrefetch = deployFlowMixin.doDeployWithPrefetch;

DeployEngine.prototype.executeDeployment = executeMixin.executeDeployment;
DeployEngine.prototype.persistStateAfterOutputFailure = executeMixin.persistStateAfterOutputFailure;

DeployEngine.prototype.provisionResource = provisionMixin.provisionResource;
DeployEngine.prototype.provisionResourceBody = provisionMixin.provisionResourceBody;

DeployEngine.prototype.provisionDelete = deleteMixin.provisionDelete;

DeployEngine.prototype.provisionUpdate = updateMixin.provisionUpdate;
DeployEngine.prototype.updateByReplacement = updateReplaceMixin.updateByReplacement;
DeployEngine.prototype.updateInPlace = updateInPlaceMixin.updateInPlace;

DeployEngine.prototype.provisionCreate = createMixin.provisionCreate;

DeployEngine.prototype.healStaleAttributes = healMixin.healStaleAttributes;
DeployEngine.prototype.isHealEligible = healMixin.isHealEligible;
DeployEngine.prototype.readStaleAttributes = healMixin.readStaleAttributes;
DeployEngine.prototype.withHealedAttributes = healMixin.withHealedAttributes;
DeployEngine.prototype.hasUnpersistedHeals = healMixin.hasUnpersistedHeals;

DeployEngine.prototype.replacementDeleteContext = replacementMixin.replacementDeleteContext;
DeployEngine.prototype.prepareFinalSnapshotForDelete =
  replacementMixin.prepareFinalSnapshotForDelete;
DeployEngine.prototype.replaceDeleteFirstAndRecreate =
  replacementMixin.replaceDeleteFirstAndRecreate;
DeployEngine.prototype.typeChangeNameQuestion = replacementMixin.typeChangeNameQuestion;
DeployEngine.prototype.checkedReplacementNameChange = replacementMixin.checkedReplacementNameChange;
DeployEngine.prototype.createFirstThenDeleteOld = replacementMixin.createFirstThenDeleteOld;
DeployEngine.prototype.deleteReplacedAfterCreate = replacementMixin.deleteReplacedAfterCreate;

DeployEngine.prototype.diffLogMasker = maskingMixin.diffLogMasker;
DeployEngine.prototype.freshNoEchoParameters = maskingMixin.freshNoEchoParameters;
DeployEngine.prototype.redactParametersForDiff = maskingMixin.redactParametersForDiff;
DeployEngine.prototype.rememberRecoverableMaskedOutputs =
  maskingMixin.rememberRecoverableMaskedOutputs;
DeployEngine.prototype.absorbOutputsPassSecrets = maskingMixin.absorbOutputsPassSecrets;
DeployEngine.prototype.redactOutputs = maskingMixin.redactOutputs;
DeployEngine.prototype.registerNoEchoAttributes = maskingMixin.registerNoEchoAttributes;
DeployEngine.prototype.refuseRedactedAttributeReads = maskingMixin.refuseRedactedAttributeReads;
DeployEngine.prototype.allRecordedSecrets = maskingMixin.allRecordedSecrets;
DeployEngine.prototype.readReaderForFreshNoEchoCeiling =
  maskingMixin.readReaderForFreshNoEchoCeiling;
DeployEngine.prototype.maskForResource = maskingMixin.maskForResource;
DeployEngine.prototype.secretNameBagFor = maskingMixin.secretNameBagFor;
DeployEngine.prototype.noteSecretNamedRecord = maskingMixin.noteSecretNamedRecord;
DeployEngine.prototype.printingSecretsFor = maskingMixin.printingSecretsFor;
DeployEngine.prototype.namingSecretsFor = maskingMixin.namingSecretsFor;
DeployEngine.prototype.noteSecretNamedReads = maskingMixin.noteSecretNamedReads;

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

DeployEngine.prototype.noEchoPositionSources = noEchoMixin.noEchoPositionSources;
DeployEngine.prototype.noEchoLeavesFor = noEchoMixin.noEchoLeavesFor;
DeployEngine.prototype.applyNoEchoPersist = noEchoMixin.applyNoEchoPersist;
DeployEngine.prototype.maskOutputsByPosition = noEchoMixin.maskOutputsByPosition;
DeployEngine.prototype.warnNoEchoPhysicalId = noEchoMixin.warnNoEchoPhysicalId;
DeployEngine.prototype.seedPersistedNoEchoAttributes = noEchoMixin.seedPersistedNoEchoAttributes;
DeployEngine.prototype.noEchoAttributeOverridesFor = noEchoMixin.noEchoAttributeOverridesFor;
DeployEngine.prototype.noEchoDiffComparison = noEchoMixin.noEchoDiffComparison;
DeployEngine.prototype.noteNoEchoExactEchoes = noEchoMixin.noteNoEchoExactEchoes;
DeployEngine.prototype.establishNoEchoEchoFidelity = noEchoMixin.establishNoEchoEchoFidelity;
DeployEngine.prototype.withNoEchoExactEchoes = noEchoMixin.withNoEchoExactEchoes;

DeployEngine.prototype.handleOutputResolutionFailure = outputsMixin.handleOutputResolutionFailure;
DeployEngine.prototype.resolveOutputs = outputsMixin.resolveOutputs;
DeployEngine.prototype.buildDisplayOutputs = outputsMixin.buildDisplayOutputs;

DeployEngine.prototype.replacementNameOrigin = nameCollisionMixin.replacementNameOrigin;
DeployEngine.prototype.orphanedNameCollisionAdvice = nameCollisionMixin.orphanedNameCollisionAdvice;
