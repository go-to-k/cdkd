/**
 * Per-deploy replacement bookkeeping (`ReplacementRunState`) and the members
 * a replacement reads from the engine (`ReplacementDeps`).
 * Moved out of `deploy-engine/replacement.ts` (go-to-k/cdkd#5835), which
 * re-exports every symbol it exported, so no importer changes.
 */
import { type RollbackRetainedCopy } from '../../kept-in-history.js';
import { type DeployEngine } from '../../deploy-engine.js';
import type { ProvisionedBy } from '../../../provisioning/provider-registry.js';
import type { StackState, SupersededResourceRecord } from '../../../types/state.js';
import type { DeferredReplacedDelete } from './deferred-deletes.js';

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
   * `CompletedOperation.oldResourceRetained`. It exists because the
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
   * `CompletedOperation.oldResourceMaySurvive`, which makes the rollback
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
   * go-to-k/cdkd#6120: logical ids whose provider `update()` moved them to a
   * new physical id and left the old one live for the cleanup phase
   * (`oldPhysicalIdLeftForCleanup`), journaled on the completed op so its
   * rollback sends an Update rather than a re-Create. Cleared per `deploy()`.
   */
  oldIdLeftForCleanup = new Set<string>();

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
  /** go-to-k/cdkd#5639: the live identity read of a restore source (`restore-source-identity.ts`). */
  providerRegistry: () => DeployEngine['providerRegistry'];
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
