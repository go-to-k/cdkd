import { clearCreatedReportOnReturn } from '../../provisioning/created-resource-sink.js';
import type { NoEchoDeleteValues } from '../noecho-delete-reresolution.js';
import { type RollbackRetainedCopy } from '../kept-in-history.js';
import { type DeployEngine, EMPTY_SECRETS, InterruptedError } from '../deploy-engine.js';
import { printingSecretsFor, secretNameBagFor } from './masking.js';
import {
  ATOMIC_FINAL_SNAPSHOT_TYPES,
  PRE_DELETE_SNAPSHOT_TYPES,
  buildFinalSnapshotIdentifier,
  ccRoutedFinalSnapshotError,
  createPreDeleteFinalSnapshot,
  replacementDeletePolicy,
  unsupportedFinalSnapshotError,
} from '../../provisioning/final-snapshot.js';
import type { ProvisionedBy } from '../../provisioning/provider-registry.js';
import { explicitNamePropertyFor } from '../../provisioning/resource-name.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceProvider,
} from '../../types/resource.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../../types/state.js';
import {
  SUPERSEDED_KEPT_REMEDY,
  addSuperseded,
  canRecordSuperseded,
  removeSuperseded,
  retryWhileInUse,
} from '../superseded-resources.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { green } from '../../utils/colors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { asIsMessage, displayAwsMessage, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { deleteSkipReason, deleteSkippedMessage } from '../delete-outcome.js';
import { replacedDeleteFailureVerdict } from '../rollback-executor/replaced-survivor.js';
import {
  type ReportedDeleteGuard,
  collectDeleteGuards,
  reportDeleteGuards,
} from '../delete-guard-scope.js';
import { isStandaloneInlinePolicyType } from '../inline-policy-claims.js';
import {
  type ReplacementNameChange,
  probeErrorMeansNameHeld,
  probeFoundSameId,
  replacementCreateAdoptsName,
  replacementMovesEventBus,
  replacementNameProbe,
  replacementOrderIsCaseSensitive,
  renderReplacementNameChange,
  replacementRequestsDifferentName,
  maskRewrittenSentName,
  replacementSentNameMoves,
  replacementGeneratedNameMoves,
} from '../replacement-name-holder.js';
import { withCurrentResourceSecrets, withPrintingSecrets } from '../resource-secrets-scope.js';
import { withRetry } from '../retry.js';
import { withStackRecords } from '../stack-records-scope.js';
import { generatedReplacementHolderAdvice } from './name-collision.js';
import {
  isNameCollisionErrorFrom,
  isRecreateRetryableError,
  markNonRetryable,
  markRedactedCause,
} from '../retryable-errors.js';
import {
  type RecordedSecretValues,
  SECRET_MASK,
  createSecretMasker,
  createUnionSecretMasker,
  maskSecretsInError,
  maskSecretsInText,
  unionOfSecretBags,
} from '../secret-redaction.js';

/**
 * One deploy's replacement bookkeeping: what each replacement did to its OLD
 * resource (retained, may survive, deleted before the create, re-created
 * under the same id), the deletes it deferred or skipped, and what each
 * in-place update reported. `deploy()` replaces the whole object rather than
 * clearing it in place, so a reused engine never journals or rolls back with
 * a previous deploy's verdicts.
 */
export class ReplacementRunState {
  /**
   * go-to-k/cdkd#4043 (review MEDIUM-3): per logical id, why a create-first
   * replacement's delete of the OLD resource was skipped (its delete address
   * is a redacted `***`, or a provider otherwise declined), leaving it alive
   * and untracked. `provisionResource` turns it into the row's
   * `updatePartial`, so the deploy exits 2 like any survivor
   * (`--allow-unaddressed` opts out).
   */
  replacedDeleteSkips = new Map<string, string>();
  /**
   * go-to-k/cdkd#4900: a replacement's failed delete of its OLD resource,
   * per logical id, retried once after the DAG. Defined only while
   * `executeDeployment` runs; a delete outside it warns at once.
   */
  deferredReplacedDeletes: Map<string, DeferredReplacedDelete> | undefined = undefined;
  /**
   * go-to-k/cdkd#5111: the deploy's live state record, where a deferred
   * delete's old resource is recorded (`StackState.supersededResources`) so
   * the row's own save persists it. Set beside `deferredReplacedDeletes`.
   */
  supersededHost: Pick<StackState, 'supersededResources'> | undefined = undefined;
  /** go-to-k/cdkd#5111: the entry each deferred delete recorded, per logical id. */
  supersededEntries = new Map<string, SupersededResourceRecord>();
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
   * FAILED, was SKIPPED, or was blocked by a failed final snapshot may also
   * leave the old resource alive, but the deploy does not KNOW it survived —
   * those go in {@link replacedOldMaySurvive} instead.
   *
   * Cleared per `deploy()` alongside the other per-run maps: a `false` here
   * must mean "this deploy deleted it", never "a previous run said so".
   */
  retainedOldOnReplacement = new Set<string>();

  /**
   * go-to-k/cdkd#2631: logical ids whose replacement's cleanup delete of the
   * OLD resource did not confirm it gone (failed, deferred, skipped, or
   * blocked by a failed final snapshot), with the verdict stamped as
   * {@link CompletedOperation.oldResourceMaySurvive}, which makes the rollback
   * read AWS for the old resource before re-creating it. Cleared per
   * `deploy()`.
   */
  replacedOldMaySurvive = new Map<string, 'kept' | 'unconfirmed'>();

  /**
   * go-to-k/cdkd#4411: logical ids this deploy destroyed and re-created under
   * the SAME physical id (a fixed-name recreate, a delete-first `--replace`).
   * What AWS stored inside the old resource went with it, so the UPDATE arm
   * re-creates such a child (`child-of-recreated-parent.ts`) rather than
   * skipping it as unchanged. Cleared per `deploy()`.
   */
  recreatedUnderSameId = new Set<string>();

  /**
   * go-to-k/cdkd#4443: the children of a `recreatedUnderSameId` parent whose
   * re-create / re-put completed in this deploy. A failed deploy forgets the
   * state record of every OTHER such child (it is gone from AWS), so the next
   * deploy creates it. Cleared per `deploy()`.
   */
  restoredLostChildren = new Set<string>();

  /**
   * go-to-k/cdkd#4443: logical ids whose provider update reported it sent
   * NOTHING (`sentNothing`, Cloud Control's empty patch). A lost `reput` child
   * among them restored nothing, so a failed deploy treats it as unwritten
   * even though its operation completed, or threw afterwards. Cleared per
   * `deploy()`.
   */
  updatesThatSentNothing = new Set<string>();

  /**
   * go-to-k/cdkd#4615: the provider's `wasReplaced` answer for each UPDATE
   * that ran through a provider `update()`, journaled on its completed op. An
   * in-place update may still change the physical id (an SQS QueuePolicy's is
   * its first queue), and only this answer tells the rollback to revert it in
   * place instead of re-creating the old one and deleting the "new" one.
   * Cleared per `deploy()`.
   */
  updateWasReplaced = new Map<string, boolean>();

  /**
   * State schema v12 (go-to-k/cdkd#4847 / #4852): per record UPDATED IN PLACE
   * that holds a token, its type's create-only paths (`'all'` when not known),
   * for the persist writer's union rule. Cleared per `deploy()`.
   */
  inPlaceCreateOnlyPaths = new Map<string, ReadonlyArray<readonly string[]> | 'all'>();

  /**
   * go-to-k/cdkd#4604: logical ids whose replacement deleted (or found gone)
   * the old resource BEFORE its create ran. A replacement orphan journaled for
   * one says so, so a rollback warns that the old resource is gone instead of
   * settling the failed UPDATE as a no-op. Cleared per `deploy()`.
   */
  oldDeletedBeforeCreate = new Set<string>();

  /**
   * go-to-k/cdkd#5064 phase 2: per logical id this deploy REPLACED (or tried
   * to) on a stack with an instance id, the name generation its new resource
   * was created at. Journaled on the op that failed (`FailedOperation.
   * nameGeneration`), so `cdkd rollback --revert-failed` raises the restored
   * record's high-water mark past a copy the failed create may have made.
   * Cleared per `deploy()`.
   */
  attemptedNameGeneration = new Map<string, number>();
}

/**
 * What this module's plain functions read from the engine beyond
 * {@link ReplacementRunState}, built at each call site as
 * `DeployEngine.replacementDeps()`. `options` / `stackRegion` / `logger` are never
 * reassigned after construction, so they are values; `secretsRun` (replaced
 * per `deploy()`), `stackRecordsView` / `deployStateResources` (set by
 * `executeDeployment`) and `interrupted` / `interruptCause` (set mid-deploy)
 * are live getters, and the engine methods stay bound to the calling engine.
 */
export interface ReplacementDeps {
  options: DeployEngine['options'];
  stackRegion: DeployEngine['stackRegion'];
  logger: DeployEngine['logger'];
  secretsRun: () => DeployEngine['secretsRun'];
  stackRecordsView: () => DeployEngine['stackRecordsView'];
  deployStateResources: () => DeployEngine['deployStateResources'];
  interrupted: () => DeployEngine['interrupted'];
  interruptCause: () => DeployEngine['interruptCause'];
  userInterrupted: () => DeployEngine['userInterrupted'];
  withRetry: DeployEngine['withRetry'];
  maskingRetryLoggerFor: DeployEngine['maskingRetryLoggerFor'];
  inlinePolicyClaimedFor: DeployEngine['inlinePolicyClaimedFor'];
  recordEvent: DeployEngine['recordEvent'];
  /**
   * go-to-k/cdkd#5064 phase 2: run a replacement's create through the
   * generated-name guard (`guardedReplacementCreate`, `create.ts`).
   */
  guardedReplacementCreate: <T>(
    input: {
      logicalId: string;
      resourceType: string;
      stackName: string;
      createdVia: ProvisionedBy | undefined;
      resolvedProps: Record<string, unknown>;
    },
    create: () => Promise<T>
  ) => Promise<T>;
  /** Does the generated-name guard check `logicalId`'s create (its replacement included)? */
  generatedNameGuarded: (logicalId: string) => boolean;
  /**
   * go-to-k/cdkd#5143: the copies this stack's rollbacks kept under
   * `UpdateReplacePolicy: Retain`, read from its event history. Asked only
   * on the name-collision refusal, so a deploy that succeeds reads nothing.
   */
  rollbackRetainedCopies?: (stackName: string) => Promise<RollbackRetainedCopy[]>;
}

/**
 * What a replacement's delete of the OLD resource tells the provider
 * (issue #4029): the governing `UpdateReplacePolicy`, and the
 * `--skip-final-snapshot` opt-out. `CloudControlProvider.delete` reads both
 * to keep an RDS cluster or instance off the registry handler, which would
 * otherwise take an untagged snapshot of its own.
 */
export function replacementDeleteContext(
  deps: ReplacementDeps,
  updateReplacePolicy: string | undefined
): {
  deletionPolicy: string;
  skipFinalSnapshot?: true;
} {
  return {
    deletionPolicy: replacementDeletePolicy(updateReplacePolicy),
    ...(deps.options.skipFinalSnapshot === true && { skipFinalSnapshot: true as const }),
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
 *
 * `mask` is the caller's secret masker, when it holds one: the snapshot
 * helper's info and debug lines (a withheld AWS failure's text among them,
 * go-to-k/cdkd#2319) go through it, as `rollback-executor/names.ts` does.
 */
export async function prepareFinalSnapshotForDelete(
  deps: ReplacementDeps,
  logicalId: string,
  resourceType: string,
  currentResource: { physicalId: string; provisionedBy?: 'sdk' | 'cc-api' | undefined },
  policy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  mask?: (text: string) => string
): Promise<string | undefined> {
  if (policy !== 'Snapshot' || deps.options.skipFinalSnapshot === true) return undefined;
  if (ATOMIC_FINAL_SNAPSHOT_TYPES.has(resourceType) && currentResource.provisionedBy !== 'cc-api') {
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
      deps.options.finalSnapshotClients ?? getAwsClients(),
      mask === undefined
        ? deps.logger
        : {
            info: (message) => deps.logger.info(mask(message)),
            debug: (message) => deps.logger.debug(mask(message)),
          }
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
export async function replaceDeleteFirstAndRecreate(
  run: ReplacementRunState,
  deps: ReplacementDeps,
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
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  /** The layer `oldDeleteProvider` was routed to, for a guard row (issue #2422). */
  oldDeleteProvisionedBy: 'sdk' | 'cc-api' | undefined,
  /** go-to-k/cdkd#4682: today's values at the old record's NoEcho coordinates. */
  noEchoDeleteValues?: NoEchoDeleteValues
): Promise<Awaited<ReturnType<ResourceProvider['create']>>> {
  const createContext: CreateContext = { maskSecrets: createSecretMasker(secrets) };
  // go-to-k/cdkd#2007: the bag this deploy resolved plus the name bag, which
  // covers a physical id derived from a secret: the old resource's delete and
  // its final snapshot's lines log under it.
  const deleteMask = createUnionSecretMasker([
    secrets,
    secretNameBagFor(deps.secretsRun(), logicalId),
  ]);
  // `UpdateReplacePolicy: Snapshot` (issue #1354): snapshot the OLD
  // resource before the replacement delete, exactly like the destroy
  // paths honor `DeletionPolicy: Snapshot`. Deliberately OUTSIDE the
  // delete's try: a snapshot failure/refusal here must surface with its
  // own typed FINAL_SNAPSHOT_* error, not be rewrapped as "Failed to
  // delete old resource ..." for a delete that was never attempted.
  const finalSnapshotIdentifier = await prepareFinalSnapshotForDelete(
    deps,
    logicalId,
    oldResourceType,
    currentResource,
    updateReplacePolicy,
    deleteMask
  );
  let deleteResult: void | ResourceDeleteResult;
  try {
    deleteResult = await withPrintingSecrets(secrets, () =>
      oldDeleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        oldResourceType,
        currentResource.properties,
        {
          expectedRegion: deps.stackRegion,
          // Replacement delete: `--force-stateful-recreation` is the user's
          // explicit data-loss consent, so thread it to the provider's data
          // guard (issue #1340).
          forceDataDelete: deps.options.forceStatefulRecreation === true,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          ...replacementDeleteContext(deps, updateReplacePolicy),
          recordedAttributes: currentResource.attributes,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: currentResource.noEchoLeaves,
          ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
          // go-to-k/cdkd#2007: the bag this deploy resolved, which the call
          // also logs under; the physical id can be a name it derives.
          maskSecrets: deleteMask,
        }
      )
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
    //
    // go-to-k/cdkd#1889: the delete's error is chained as `cause` so its
    // markers (`markNonRetryable`, wait-abandoned, `$metadata` / `Code` for
    // `extractDeploymentEventError`) survive the wrap — a wrap with no cause
    // severs every one of them. Chained through `maskSecretsInError` with the
    // same bag as the message, for the message mask's reason: a bare cause
    // would carry, in the chain `formatError` prints, the plaintext the
    // message mask removed, held off only by the downstream reader.
    // go-to-k/cdkd#2676: the message is flattened HERE, so it is masked here
    // with the PRINTING bag too (a secret-derived name, #4741's previous NoEcho
    // value): a later mask sees only the flattened text and misses a needle
    // that holds a newline.
    const shownSecrets = unionOfSecretBags([
      secrets,
      printingSecretsFor(deps.secretsRun(), logicalId),
    ]);
    // go-to-k/cdkd#2319: an AWS-authored failure (an SDK error a provider let
    // escape) is named by its class, with AWS's text in `debug`
    // ({@link fallbackFailureText}). Nothing between here and the DAG
    // executor reads this message for "already gone".
    const deleteText = fallbackFailureText(
      deps,
      deleteError,
      shownSecrets,
      (failure) =>
        // Each value masked BEFORE `safeMsg` flattens it (go-to-k/cdkd#2676): a
        // flattened newline inside a secret would no longer match its needle.
        safeMsg`Failed to delete old resource ${maskSecretsInText(logicalId, shownSecrets)} ` +
        safeMsg`(${maskSecretsInText(currentResource.physicalId, shownSecrets)}) ` +
        `during the --replace delete-first fallback: ` +
        // go-to-k/cdkd#2676: the wrapped error's (masked) message is embedded
        // as-is and LAST: it can end in cdkd's own remedy command lines.
        safeMsg`${asIsMessage(failure)}`
    );
    throw stampRedacted(
      new Error(deleteText.message, {
        cause: deleteError instanceof Error ? maskSecretsInError(deleteError, secrets) : undefined,
      }),
      deleteText.redacted
    );
  }
  // Issue #1762: a skip here FAILS the resource, unlike the template-DELETE
  // branch. The old resource is still alive and the whole point of this
  // path is that the re-create needs its name released — proceeding would
  // either collide or, for a type with no name conflict, leave two live
  // resources with state describing one. Checked outside the catch above so
  // the wrapping never sees it (a return value, not a throw).
  // Issue #2422: before the skip check below, which throws.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType: oldResourceType,
    provisionedBy: oldDeleteProvisionedBy,
  });
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
  deps.logger.info(safeMsg`  ${green('✓')} Old resource deleted`);
  run.oldDeletedBeforeCreate.add(logicalId);
  // go-to-k/cdkd#5131: a type whose delete returns while AWS still holds the
  // name (a DynamoDB table, DELETING) waits here, where the delete is known to
  // be this run's own; no other path pays it.
  await oldDeleteProvider.waitForNameReleased?.(
    logicalId,
    currentResource.physicalId,
    oldResourceType,
    {
      isInterrupted: () => deps.userInterrupted(),
      maskSecrets: (text) => maskSecretsInText(text, secrets),
    }
  );
  deps.logger.info(safeMsg`  Re-creating ${logicalId}...`);
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
        deps.withRetry(
          // Issue #1903, same scope as the ordinary CREATE path: bind the
          // resolved-secrets bag around every provider create, so no
          // replacement route can silently skip the nested-stack seed.
          () =>
            clearCreatedReportOnReturn(() =>
              withCurrentResourceSecrets(secrets, () =>
                replaceProvider.create(logicalId, resourceType, replaceProps, createContext)
              )
            ),
          logicalId,
          undefined,
          undefined,
          replaceProvider,
          // The old resource is gone: only the user's interrupt stops it.
          true
        ),
      logicalId,
      {
        maxRetries: 8,
        initialDelayMs: 2_000,
        maxDelayMs: 10_000,
        // Issue #2038: `replaceProps` is RESOLVED, so mask the AWS message
        // this retry echoes. Bound to the CALLER's bag (the `secrets`
        // parameter above), not looked up by logical id -- see
        // `DeployEngine.maskingRetryLoggerFor`.
        logger: deps.maskingRetryLoggerFor(secrets),
        // The old resource is already deleted: only the user's interrupt
        // stops this re-create. A sibling's failure (which sets the same
        // flag) left the stack with neither copy (generated-name-lifecycle A5).
        isInterrupted: () => deps.userInterrupted(),
        onInterrupted: () => new InterruptedError('user'),
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
    // UPDATE-not-supported fallback. The `cause` is chained through
    // `maskSecretsInError` with the message's bag, like the delete wrap
    // above (go-to-k/cdkd#1889). `provisionResource`'s catch masks the whole
    // chain again further up, so this is the same defense-in-depth as the
    // message mask: no resolved secret value exists inside the thrown chain.
    // (A name derived from a secret is masked only there, by the printing
    // bag `printingSecretsFor` adds.) The `cause` is what keeps the AWS
    // rejection behind the sentence readable — `extractDeploymentEventError`
    // walks the chain for `$metadata` / `Code`, so an unchained wrap sends a
    // `RESOURCE_FAILED` event with no `awsErrorCode` at all. Nothing between
    // here and the DAG executor re-classifies the throw (the retry loop is
    // the `withRetry` above, already exhausted), so chaining cannot revive a
    // retry off the cause's text.
    // go-to-k/cdkd#2676: the message is flattened HERE, so it is masked here
    // with the PRINTING bag too (a secret-derived name, #4741's previous NoEcho
    // value): a later mask sees only the flattened text and misses a needle
    // that holds a newline.
    const shownSecrets = unionOfSecretBags([
      secrets,
      printingSecretsFor(deps.secretsRun(), logicalId),
    ]);
    // go-to-k/cdkd#2319: as the delete wrap above ({@link fallbackFailureText}).
    const recreateText = fallbackFailureText(
      deps,
      recreateError,
      shownSecrets,
      (failure) =>
        safeMsg`Failed to re-create ${maskSecretsInText(logicalId, shownSecrets)} after the ` +
        safeMsg`--replace delete-first fallback already deleted the old resource (${maskSecretsInText(currentResource.physicalId, shownSecrets)}). ` +
        // go-to-k/cdkd#2676: the wrapped error's (masked) message is embedded
        // as-is and LAST: it can end in cdkd's own remedy command lines.
        safeMsg`Re-run the deploy to create it fresh. Cause: ${asIsMessage(failure)}`
    );
    throw stampRedacted(
      new Error(recreateText.message, {
        cause:
          recreateError instanceof Error ? maskSecretsInError(recreateError, secrets) : undefined,
      }),
      recreateText.redacted
    );
  }
}

/**
 * The message of a `--replace` delete-first fallback wrap (go-to-k/cdkd#2319).
 *
 * The thrown message is persisted to `deployments/{runId}.jsonl`, and an
 * AWS-authored failure (an SDK error a provider let escape) names the caller's
 * ARN on an access denial: `build` then gets the error's class plus the
 * `--verbose` pointer, and the message built from AWS's own text goes to
 * `debug`. A cdkd-authored failure (a provider's own wrap) or a transport
 * error is passed through as before. Every text is masked with `secrets`
 * before `build` flattens it. `redacted` says to stamp the wrap
 * `markRedactedCause`, so a classifier reads the withheld text on the chain.
 */
function fallbackFailureText(
  deps: Pick<ReplacementDeps, 'logger'>,
  error: unknown,
  secrets: RecordedSecretValues,
  build: (failure: string) => string
): { message: string; redacted: boolean } {
  const failure = describeAwsFailure(error);
  const detail = maskSecretsInText(failure.detail, secrets);
  if (!failure.redacted) return { message: build(detail), redacted: false };
  deps.logger.debug(build(detail));
  return { message: build(maskSecretsInText(failure.summary, secrets)), redacted: true };
}

/** {@link markRedactedCause} when `redacted` and the wrap has a cause to read. */
function stampRedacted(error: Error, redacted: boolean): Error {
  return redacted && error.cause instanceof Error ? markRedactedCause(error) : error;
}

/**
 * The name a Type-changed replacement asks for, as a change to probe
 * (go-to-k/cdkd#3937): across two types the "same" name is not one the old
 * resource holds in the new type's name space. `undefined` without an
 * explicit, plain name (a generated one is not compared).
 */
export function typeChangeNameQuestion(
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
export async function checkedReplacementNameChange(
  deps: ReplacementDeps,
  input: {
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
  }
): Promise<ReplacementNameChange | undefined> {
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
  const generatedMove = replacementGeneratedNameMoves({
    oldResourceType: input.oldResourceType,
    newResourceType: resourceType,
    createdVia: input.createdVia,
    desiredProperties: input.desiredProperties,
    physicalId: currentResource.physicalId,
    logicalId,
  });
  const change =
    replacementRequestsDifferentName(question) ??
    (adopts || replacementOrderIsCaseSensitive(resourceType)
      ? replacementRequestsDifferentName({ ...question, caseSensitive: true })
      : undefined) ??
    replacementMovesEventBus(question) ??
    replacementSentNameMoves({
      oldResourceType: input.oldResourceType,
      newResourceType: resourceType,
      createdVia: input.createdVia,
      desiredProperties: input.desiredProperties,
      physicalId: currentResource.physicalId,
      logicalId,
    }) ??
    (adopts && typeChanged ? typeChangeNameQuestion(resourceType, input) : undefined) ??
    // go-to-k/cdkd#5064 phase 2: a generated name at the next generation.
    generatedMove;
  if (change === undefined) return undefined;
  // That move is checked by the generated-name guard when it planned the
  // replacement (a lookup at plan time, the intent in the ledger so a crash
  // re-run takes its own resource back); the probe below covers the rest.
  if (change === generatedMove && deps.generatedNameGuarded(logicalId)) return change;
  const probe = replacementNameProbe({
    resourceType,
    createdVia: input.createdVia,
    change,
    region: deps.stackRegion,
  });
  if (probe === undefined) return change;
  // A secret-derived name a provider rewrites before sending (ELBv2) is
  // printed by AWS, and in the holder's ARN, in a spelling the recorded
  // secrets do not match: mask that spelling too.
  const maskName = maskRewrittenSentName(resourceType, input.createProps, logicalId, (text) =>
    maskSecretsInText(text, secrets)
  );
  const subject = `${displaySafe(logicalId)} (${displaySafe(resourceType)})`;
  const adoptsText =
    `its create API hands back or overwrites an existing resource of that name instead of ` +
    `refusing it`;
  if (probe === null) {
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd cannot ` +
            `check whether another resource already holds it. Nothing was created or deleted.`
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
    found = await deps.withRetry(
      () =>
        lookup({
          logicalId,
          resourceType,
          stackName: input.stackName,
          region: deps.stackRegion,
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
          maskName(
            `${subject} requires replacement, and S3 answered 403 Forbidden for bucket ` +
              `${displaySafe(change.desiredName)}: another account owns that name, or a bucket ` +
              `of this account denies this identity \`s3:ListBucket\`, or the request's ` +
              `credentials were rejected. Nothing was created or deleted. Choose another name, ` +
              `or if the bucket is yours grant \`s3:ListBucket\` on it (or delete it) and ` +
              `re-run.`
          ),
          'NAMED_REPLACEMENT_COLLISION',
          probeError instanceof Error ? probeError : undefined
        )
      );
    }
    // go-to-k/cdkd#2319: the thrown message is persisted to
    // `deployments/{runId}.jsonl`, and an AWS-authored probe failure (an
    // `AccessDenied`) names the caller's ARN and account. It is named by its
    // class plus the `--verbose` pointer, AWS's own text goes to `debug`
    // masked, and the wrap is stamped so a classifier still reads that text
    // on the `cause` chain. A cdkd-authored or transport failure keeps its text.
    const failure = describeAwsFailure(probeError);
    const failureText = (text: string): string =>
      maskName(
        `${subject} requires replacement under a new name, and ${adoptsText}, but cdkd could ` +
          `not check whether another resource already holds it: ${text}${text.endsWith('.') ? '' : '.'} ` +
          `Nothing was created or deleted. Re-run the deploy once the check can succeed.`
      );
    const awsText = displayAwsMessage(maskName(failure.detail));
    if (failure.redacted) deps.logger.debug(failureText(awsText));
    const refusal = new CdkdError(
      failureText(failure.redacted ? displaySafe(maskName(failure.summary)) : awsText),
      'NAMED_REPLACEMENT_COLLISION',
      probeError instanceof Error ? probeError : undefined
    );
    throw markNonRetryable(
      failure.redacted && probeError instanceof Error ? markRedactedCause(refusal) : refusal
    );
  }
  if (found === null) return change;
  if (
    !typeChanged &&
    probeFoundSameId(resourceType, found.physicalId, currentResource.physicalId)
  ) {
    return undefined;
  }
  // go-to-k/cdkd#5143: the holder may be this resource's own copy that an
  // earlier rolled-back deploy kept; say so only when the history shows it.
  const keptByRollback =
    (await deps.rollbackRetainedCopies?.(input.stackName).catch(() => [])) ?? [];
  const ownRetainedCopy = keptByRollback.some(
    (copy) =>
      copy.logicalId === logicalId &&
      copy.resourceType === resourceType &&
      probeFoundSameId(resourceType, copy.physicalId, found.physicalId)
  );
  // Worded from what the history records, not as a fact about the live
  // holder: the copy may since have been deleted and the name taken by an
  // unrelated resource, which the advice must not tell anyone to delete.
  const remedy = ownRetainedCopy
    ? `This stack's event history records that a rolled-back deploy kept ` +
      `${displaySafe(logicalId)}'s replacement under this name because of ` +
      `UpdateReplacePolicy: Retain, as CloudFormation also does, untracked by cdkd. If the ` +
      `holder is that copy and you no longer need it, delete it; otherwise choose another name.`
    : `Choose a name no other resource holds, or delete the resource holding it if it is yours.`;
  throw markNonRetryable(
    new CdkdError(
      maskName(
        `${subject} requires replacement, and another existing resource ` +
          `(${displaySafe(found.physicalId)}) already holds the name it asks for. ` +
          `${renderReplacementNameChange(change, input.createProps)}. Since ${adoptsText}, creating the replacement ` +
          `would take that resource over and record it as this stack's. Nothing was ` +
          `created or deleted. ${remedy}`
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
export async function createFirstThenDeleteOld(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  input: {
    logicalId: string;
    resourceType: string;
    oldResourceType: string;
    currentResource: ResourceState;
    createProvider: ResourceProvider;
    createProps: Record<string, unknown>;
    deleteProvider: ResourceProvider;
    /** The layer `deleteProvider` was routed to, for a guard row (issue #2422). */
    deleteProvisionedBy: 'sdk' | 'cc-api' | undefined;
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
    /** go-to-k/cdkd#4682: today's values at the old record's NoEcho coordinates. */
    noEchoDeleteValues?: NoEchoDeleteValues | undefined;
    /** go-to-k/cdkd#5064 phase 2: what the generated-name guard reads. */
    stackName: string;
    createdVia: ProvisionedBy | undefined;
    resolvedProps: Record<string, unknown>;
  }
): Promise<ResourceCreateResult> {
  const { logicalId, resourceType, currentResource, secrets } = input;
  const retainOld = input.retainOld === true;
  // Before the create, so a refusal changes nothing. A PRE_DELETE_SNAPSHOT
  // type would take its snapshot here, before the create window; none of
  // them has a name `replacementRequestsDifferentName` reads, so none
  // reaches this method.
  const finalSnapshotIdentifier = retainOld
    ? undefined
    : await prepareFinalSnapshotForDelete(
        deps,
        logicalId,
        input.oldResourceType,
        currentResource,
        input.snapshotPolicy,
        // A superset of the delete's masker below (`createSecretMasker(secrets)`):
        // the resolved bag plus the #2007 name bag. No PRE_DELETE_SNAPSHOT type
        // reaches this method today, so no snapshot line is logged here yet.
        createUnionSecretMasker([secrets, secretNameBagFor(deps.secretsRun(), logicalId)])
      );
  deps.logger.info(
    retainOld
      ? safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource (the old one is retained)...`
      : safeMsg`  ${logicalId}'s new name differs from the one the old resource holds — creating the new resource before deleting the old one...`
  );
  // The rewritten spelling of a secret-derived name (ELBv2), under either
  // prefix flag, is in AWS's text, the physical ids and the rendered name
  // change, where the literal mask misses it.
  const maskName = maskRewrittenSentName(resourceType, input.createProps, logicalId, (text) =>
    maskSecretsInText(text, secrets)
  );
  let createResult: ResourceCreateResult;
  try {
    createResult = await deps.guardedReplacementCreate(
      {
        logicalId,
        resourceType,
        stackName: input.stackName,
        createdVia: input.createdVia,
        resolvedProps: input.resolvedProps,
      },
      () =>
        deps.withRetry(
          () =>
            clearCreatedReportOnReturn(() =>
              withCurrentResourceSecrets(secrets, () =>
                input.createProvider.create(logicalId, resourceType, input.createProps, {
                  maskSecrets: createSecretMasker(secrets),
                })
              )
            ),
          logicalId,
          undefined,
          undefined,
          input.createProvider
        )
    );
  } catch (createError) {
    // The old resource is untouched: a raw failure is the whole story.
    if (!isNameCollisionErrorFrom(createError, logicalId)) throw createError;
    // go-to-k/cdkd#2319: the refusal is persisted, so an AWS-authored
    // collision is quoted by its class plus the `--verbose` pointer and AWS's
    // text goes to `debug`. No reader needs AWS's wording in this MESSAGE:
    // `isNameCollisionErrorFrom` reads the chain, the rollback keys on the
    // code, and the "the create collided" sentence is cdkd's. A provider's
    // own wrap keeps its text.
    const createFailure = describeAwsFailure(createError);
    const createAwsMsg = displayAwsMessage(maskName(createFailure.detail));
    const createMsg = createFailure.redacted
      ? displaySafe(maskName(createFailure.summary)).replace(/\.$/, '')
      : createAwsMsg;
    if (createFailure.redacted) {
      deps.logger.debug(
        safeMsg`${maskName(logicalId)}: the create-first attempt collided: ${asIsMessage(createAwsMsg)}`
      );
    }
    // Marked: the message quotes the collision text, which the recreate
    // retry classifier would otherwise retry for minutes.
    throw markNonRetryable(
      new CdkdError(
        maskName(
          `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
            `(${input.trigger}), and cdkd created the new resource first because its name ` +
            `differs, but the create collided: ${createMsg}. If the collision is on the ` +
            `requested name: ${renderReplacementNameChange(input.change, input.createProps)}. Nothing was deleted` +
            (retainOld ? ` (UpdateReplacePolicy: Retain keeps the old resource in place)` : '') +
            `. Choose a name no other resource holds, or delete the resource holding it if it ` +
            `is yours.` +
            generatedReplacementHolderAdvice({
              stackName: input.stackName,
              logicalId,
              change: input.change,
              oldPhysicalId: currentResource.physicalId,
              // The printing bag too: the old name can be secret-derived.
              mask: (text: string) =>
                maskName(
                  maskSecretsInText(
                    text,
                    unionOfSecretBags([secrets, printingSecretsFor(deps.secretsRun(), logicalId)])
                  )
                ),
            })
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
        maskName(
          `${displaySafe(logicalId)} (${displaySafe(resourceType)}) requires replacement ` +
            `(${input.trigger}) under a new name, but the create returned the resource being ` +
            `replaced (${displaySafe(currentResource.physicalId)}) instead of a new one, so ` +
            `cdkd cannot tell which name it holds. Nothing was deleted. Delete that resource ` +
            `by hand if it is yours, then re-run the deploy.`
        ),
        'NAMED_REPLACEMENT_IDEMPOTENT_CREATE'
      )
    );
  }
  if (retainOld) return createResult;
  deps.logger.info(safeMsg`  Deleting old ${logicalId} (${currentResource.physicalId})...`);
  await deleteReplacedAfterCreate(
    run,
    deps,
    logicalId,
    input.oldResourceType,
    currentResource,
    input.deleteProvider,
    input.deleteProperties,
    finalSnapshotIdentifier,
    input.deletePolicy,
    secrets,
    input.deleteProvisionedBy,
    input.noEchoDeleteValues
  );
  return createResult;
}

/**
 * The delete of a replaced resource once its replacement EXISTS. A failure
 * or a skip warns rather than fails the resource (issue #1762): the new
 * resource is created and about to be recorded, so the old one is untracked
 * either way, and failing here would roll back a replacement that
 * succeeded. Neither is recorded as a retention: both mark the old resource
 * as one that may survive (`replacedOldMaySurvive`, go-to-k/cdkd#2631), so a
 * rollback reads AWS for it before re-creating it. The delete
 * error is masked with `secrets` BEFORE it is rendered: a provider can echo
 * a resolved value.
 */
export async function deleteReplacedAfterCreate(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  logicalId: string,
  oldResourceType: string,
  currentResource: ResourceState,
  deleteProvider: ResourceProvider,
  deleteProperties: Record<string, unknown>,
  finalSnapshotIdentifier: string | undefined,
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined,
  secrets: RecordedSecretValues,
  /** The layer `deleteProvider` was routed to, for a guard row (issue #2422). */
  deleteProvisionedBy: 'sdk' | 'cc-api' | undefined,
  /** go-to-k/cdkd#4682: today's values at the old record's NoEcho coordinates. */
  noEchoDeleteValues?: NoEchoDeleteValues,
  /** go-to-k/cdkd#4900: the post-DAG retry, which warns rather than defers. */
  isRetry = false
): Promise<void> {
  // Initialized because the catch below can leave it unassigned.
  let deleteResult: void | ResourceDeleteResult = undefined;
  let deleteFailed = false;
  // go-to-k/cdkd#4821: a replaced standalone inline policy (`PolicyName` /
  // `RoleName` are create-only) removes its OLD name here, right after its
  // create; another writer of this deploy may have just put that name on the
  // same principal (a swap of names with an `AWS::IAM::Policy`). Only those
  // types are handed the predicate, so every other replacement is unchanged.
  const inlinePolicyClaimed = isStandaloneInlinePolicyType(oldResourceType)
    ? deps.inlinePolicyClaimedFor(oldResourceType, logicalId, deps.deployStateResources())
    : undefined;
  try {
    const sendDelete = (): Promise<void | ResourceDeleteResult> =>
      deleteProvider.delete(
        logicalId,
        currentResource.physicalId,
        oldResourceType,
        deleteProperties,
        {
          expectedRegion: deps.stackRegion,
          forceDataDelete: deps.options.forceStatefulRecreation === true,
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          ...replacementDeleteContext(deps, updateReplacePolicy),
          // Issue #4157: the identity evidence of the record deleted.
          recordedAttributes: currentResource.attributes,
          // go-to-k/cdkd#4043: where the record holds a NoEcho mask.
          recordedNoEchoLeaves: currentResource.noEchoLeaves,
          ...(noEchoDeleteValues !== undefined && { noEchoDeleteValues }),
          ...(inlinePolicyClaimed && { inlinePolicyClaimed }),
          // go-to-k/cdkd#2007: the bag the call logs under and the delete
          // error below is masked with.
          maskSecrets: createUnionSecretMasker([
            secrets,
            secretNameBagFor(deps.secretsRun(), logicalId),
          ]),
        }
      );
    deleteResult = await withPrintingSecrets(secrets, () =>
      // go-to-k/cdkd#5111: the post-DAG retry waits out an "in use" refusal
      // whose user this deploy already moved off (a deleted load balancer's
      // listeners go asynchronously); the first attempt defers instead.
      isRetry ? retryWhileInUse(sendDelete, () => deps.interrupted()) : sendDelete()
    );
  } catch (deleteError) {
    const deleteMsg = maskSecretsInText(describeAwsFailure(deleteError).detail, secrets);
    deleteFailed = true;
    // go-to-k/cdkd#2631: before the deferral below, whose retry runs only
    // after this row's op is journaled (and not at all if the deploy fails
    // first; `execute.ts` re-stamps the op after it). A retry that then
    // deletes it leaves the mark: the rollback's read finds it gone and
    // re-creates, as it would have.
    // A retry never upgrades an earlier `'unconfirmed'`: that delete may
    // still be running.
    run.replacedOldMaySurvive.set(
      logicalId,
      run.replacedOldMaySurvive.get(logicalId) === 'unconfirmed'
        ? 'unconfirmed'
        : replacedDeleteFailureVerdict(deleteError)
    );
    // go-to-k/cdkd#4900: a resource this deploy has yet to update may still
    // use the old one (an endpoint on a replaced revision refuses its
    // delete), so the first failure inside a deploy's DAG is retried once
    // after the rest of the deploy, as CloudFormation's cleanup phase
    // deletes old resources only after every update.
    const deferred = run.deferredReplacedDeletes;
    if (!isRetry && deferred !== undefined) {
      deps.logger.info(
        safeMsg`  Could not delete old ${logicalId} (${currentResource.physicalId}) yet: ${deleteMsg}. Retrying after the rest of the deploy.`
      );
      // go-to-k/cdkd#5111: recorded BEFORE the row's save, which persists it:
      // a deploy killed before the retry below left the old resource in AWS
      // with no record at all.
      const host = run.supersededHost;
      if (
        host !== undefined &&
        canRecordSuperseded(currentResource, { noEchoDeleteValues, inlinePolicyClaimed }) &&
        // Never an id ANOTHER record of this deploy holds: a later run would
        // delete that live resource. (This row's own record still names the
        // old id until the row completes; an equal new id refused above.)
        !Object.entries(deps.deployStateResources()).some(
          ([id, record]) => id !== logicalId && record?.physicalId === currentResource.physicalId
        )
      ) {
        const entry: SupersededResourceRecord = {
          logicalId,
          supersededAt: Date.now(),
          state: currentResource,
          ...(updateReplacePolicy !== undefined && { updateReplacePolicy }),
          ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
          ...(deps.options.forceStatefulRecreation === true && { forceDataDelete: true as const }),
          ...(deps.options.skipFinalSnapshot === true && { skipFinalSnapshot: true as const }),
        };
        addSuperseded(host, entry);
        run.supersededEntries.set(logicalId, entry);
      }
      deferred.set(logicalId, {
        physicalId: currentResource.physicalId,
        resourceType: oldResourceType,
        provisionedBy: deleteProvisionedBy,
        failureMessage: deleteMsg,
        retry: () =>
          deleteReplacedAfterCreate(
            run,
            deps,
            logicalId,
            oldResourceType,
            currentResource,
            deleteProvider,
            deleteProperties,
            finalSnapshotIdentifier,
            updateReplacePolicy,
            secrets,
            deleteProvisionedBy,
            noEchoDeleteValues,
            true
          ),
      });
      return;
    }
    // Always a warning, a not-found included: an "already gone" read off the
    // MESSAGE cannot be made safe (go-to-k/cdkd#3236) — a logical id like
    // `PageNotFound`, or a delete failing on a KMS key or role "not found"
    // while the old resource is alive, would silence the one line telling
    // the user an untracked resource may be left.
    // go-to-k/cdkd#5111: the retry of a recorded delete keeps the record.
    const kept = isRetry && run.supersededEntries.has(logicalId);
    deps.logger.warn(
      kept
        ? safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}. ${SUPERSEDED_KEPT_REMEDY}.`
        : safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${currentResource.physicalId}): ${deleteMsg}`
    );
  }
  // go-to-k/cdkd#5111: a retry that deleted it, or that the provider skipped
  // (warned below as untracked), drops the record.
  const recorded = isRetry ? run.supersededEntries.get(logicalId) : undefined;
  if (recorded !== undefined && !deleteFailed && run.supersededHost !== undefined) {
    removeSuperseded(run.supersededHost, recorded);
    run.supersededEntries.delete(logicalId);
  }
  // Issue #2422.
  reportDeleteGuards(deleteResult, {
    physicalId: currentResource.physicalId,
    resourceType: oldResourceType,
    provisionedBy: deleteProvisionedBy,
  });
  const skipReason = deleteSkipReason(deleteResult);
  if (skipReason !== undefined) {
    // A skip does not say the delete was not sent (a custom-resource handler
    // that refused DID get it), so it never licenses a re-adopt.
    run.replacedOldMaySurvive.set(logicalId, 'unconfirmed');
    // go-to-k/cdkd#4043 (review MEDIUM-3): the old resource survives
    // untracked, so the row is a PARTIAL update and the deploy exits 2 unless
    // `--allow-unaddressed` (the #1819 survivor contract), not a clean one.
    run.replacedDeleteSkips.set(
      logicalId,
      `the replaced ${oldResourceType} (${currentResource.physicalId}) was not deleted (${skipReason}) and is no longer tracked by cdkd`
    );
    deps.logger.warn(
      safeMsg`  ⚠ ${deleteSkippedMessage(
        logicalId,
        currentResource.physicalId,
        skipReason,
        'while cleaning up the replaced resource',
        // No command on this line, and the id is the only trace left of the
        // resource: show it, bounded, rather than describe it
        // (go-to-k/cdkd#4265).
        { commandFreeLine: true }
      )}. Delete it manually — it is no longer tracked in state.`
    );
  } else if (!deleteFailed) {
    // go-to-k/cdkd#2631: the retry deleted it, so the mark goes: a rollback's
    // read of an eventually consistent API could still see the old resource
    // and re-adopt a deleted id.
    if (isRetry) run.replacedOldMaySurvive.delete(logicalId);
    deps.logger.info(
      isRetry
        ? safeMsg`  ${green('✓')} Old ${logicalId} (${currentResource.physicalId}) deleted`
        : safeMsg`  ${green('✓')} Old resource deleted`
    );
  }
}

/**
 * A replaced resource's delete that failed inside the DAG, kept for one retry
 * after it (go-to-k/cdkd#4900). `failureMessage` is already masked with the
 * row's resolved secrets; the lines naming it also mask the row's
 * derived-name registry, bound around each print.
 */
export interface DeferredReplacedDelete {
  physicalId: string;
  resourceType: string;
  provisionedBy: 'sdk' | 'cc-api' | undefined;
  failureMessage: string;
  /** Set by `provisionResource` when the row already ended partial. */
  rowPartial?: boolean;
  retry: () => Promise<void>;
}

/**
 * Retries every deferred delete once the deploy's creates, updates and
 * deletes have all completed (go-to-k/cdkd#4900). Each retry runs under the
 * scopes its row's inline delete had: the row's printing registry, the
 * stack's records, and a delete-guard sink emitted as the row's. A retry that
 * fails warns exactly as the inline delete did; a skip makes the row a
 * partial update, as it would have inline. At most `--concurrency` at once.
 */
export async function retryDeferredReplacedDeletes(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  stackName: string,
  counts: { updated: number; updatePartial: number }
): Promise<void> {
  const deferred = run.deferredReplacedDeletes;
  run.deferredReplacedDeletes = undefined;
  if (deferred === undefined || deferred.size === 0) return;
  deps.logger.info(safeMsg`Retrying the delete of ${deferred.size} replaced resource(s)`);
  const retryOne = async (logicalId: string, entry: DeferredReplacedDelete): Promise<void> => {
    const guards: ReportedDeleteGuard[] = [];
    try {
      await withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), () =>
        withStackRecords(deps.stackRecordsView(), () =>
          collectDeleteGuards(guards, async () => {
            deps.logger.info(safeMsg`  Deleting old ${logicalId} (${entry.physicalId})...`);
            try {
              await entry.retry();
            } catch {
              // `deleteReplacedAfterCreate` catches the provider's own error;
              // anything else must not strand the entries still queued. Its
              // text is not shown: nothing masked it.
              deps.logger.warn(
                safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${entry.physicalId}): the retry failed unexpectedly`
              );
            }
          })
        )
      );
    } finally {
      // As `provisionResource` emits the row's guards (issue #2422).
      for (const guard of guards) {
        deps.recordEvent({
          eventType: 'RESOURCE_GUARD_INDETERMINATE',
          stackName,
          operation: 'DELETE',
          logicalId,
          resourceType: guard.resourceType,
          ...(guard.provisionedBy && { provisionedBy: guard.provisionedBy }),
          ...(guard.physicalId && {
            physicalId: maskSecretsInText(
              guard.physicalId,
              deps.secretsRun().perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS
            ),
          }),
          guard: guard.guard,
          reason: guard.reason,
        });
      }
    }
    const skip = run.replacedDeleteSkips.get(logicalId);
    if (skip === undefined) return;
    run.replacedDeleteSkips.delete(logicalId);
    // As `provisionResource` turns an inline skip into the row's partial
    // update: counted once, and the survivor named in its own event.
    if (entry.rowPartial !== true) {
      counts.updated = Math.max(0, counts.updated - 1);
      counts.updatePartial++;
    }
    deps.recordEvent({
      eventType: 'RESOURCE_SKIPPED',
      stackName,
      operation: 'UPDATE',
      logicalId,
      resourceType: entry.resourceType,
      ...(entry.provisionedBy && { provisionedBy: entry.provisionedBy }),
      physicalId: entry.physicalId,
      reason: skip,
    });
  };
  const queue = [...deferred];
  const workers = Math.max(1, Math.min(deps.options.concurrency ?? 1, queue.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await retryOne(...next);
      }
    })
  );
}

/**
 * The deploy failed or was interrupted before the retry: each deferred delete
 * gets the warning its inline failure would have printed (go-to-k/cdkd#4900).
 */
export function warnUnretriedReplacedDeletes(
  run: ReplacementRunState,
  deps: ReplacementDeps,
  why: 'failed' | 'interrupted'
): void {
  const deferred = run.deferredReplacedDeletes;
  run.deferredReplacedDeletes = undefined;
  const cause = why === 'failed' ? 'the deploy failed first' : 'the deploy was interrupted';
  // go-to-k/cdkd#5111: a recorded one stays in state for the next deploy; one
  // `canRecordSuperseded` kept in memory only is no longer tracked.
  const noteFor = (logicalId: string): string =>
    run.supersededEntries.has(logicalId)
      ? `not retried: ${cause}; cdkd keeps it in state, and the next deploy retries the delete`
      : `not retried: ${cause}; it is no longer tracked in state, so delete it manually`;
  for (const [logicalId, entry] of deferred ?? []) {
    withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), () =>
      deps.logger.warn(
        safeMsg`  ⚠ Failed to delete old resource ${logicalId} (${entry.physicalId}): ${entry.failureMessage} (${noteFor(logicalId)})`
      )
    );
  }
}
