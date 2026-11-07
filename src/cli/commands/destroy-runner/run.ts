/**
 * `runDestroyForStack` and the first half of a stack's destroy: the entry
 * refusals, the empty-stack path, the listing and the prompt, and the
 * cross-region switch (split out of `../destroy-runner.ts`, go-to-k/cdkd#5835).
 */
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { getLogger } from '../../../utils/logger.js';
import {
  getCurrentNestedStackContext,
  withNestedStackContext,
} from '../../../provisioning/nested-stack-context.js';
import { setAwsClients, AwsClients } from '../../../utils/aws-clients.js';
import { runInStackAwsScope } from '../../../utils/stack-aws-scope.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { applyCrossPrefixScan } from '../../../state/cross-prefix-stack-scan.js';
import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../provisioning/register-providers.js';
import type { StackState } from '../../../types/state.js';
import { refuseMalformedOutputsForDestroy } from '../../../state/malformed-resources-bag.js';
import { StackHasActiveImportsError } from '../../../utils/error-handler.js';
import {
  holdsSupersededResources,
  supersededResourcesOf,
} from '../../../deployment/superseded-resources.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';
import type { DestroyRunnerContext, DestroyRunnerResult, StackRegionScope } from './types.js';
import { NOECHO_PRINTING_BIND_CAP_MS } from './types.js';
import {
  countProtectedResources,
  countProtectedJournaledOrphans,
  scanActiveConsumers,
} from './helpers.js';
import {
  refuseMalformedRecordAndLoadJournaledOrphans,
  destroyEmptyStack,
  announceOrphansAndConfirm,
} from './preflight.js';
import { destroyStackUnderLock } from './under-lock.js';

/**
 * Run the destroy lifecycle for one stack against an already-loaded
 * `StackState`, reusing the caller's state backend / lock manager.
 *
 * Hoisted from `cdkd destroy` so the new `cdkd state destroy` subcommand
 * can call into the exact same per-stack pipeline without depending on
 * synth or the CDK app. The state-source split is the only meaningful
 * difference between the two commands — everything from "prompt the user"
 * onwards is identical.
 *
 * Side effects:
 * - Acquires (and releases) the stack's S3 lock.
 * - Switches `process.env.AWS_REGION` for the duration of the destroy when
 *   the stack's recorded region differs from `baseRegion`. Restored in the
 *   `finally` block. Such a stack is also destroyed inside a stack AWS scope
 *   for its region, with its own provider registry, and its nested children
 *   are handed that registry and those clients (go-to-k/cdkd#4941).
 * - Persists state incrementally during the delete loop (issue #804):
 *   each successfully deleted resource is removed from the state object
 *   and the trimmed state is written back to S3, mirroring deploy's
 *   `saveStateAfterResource`. An interrupted destroy therefore leaves a
 *   state file listing only resources that still exist, so a re-run does
 *   not replay deletes against already-deleted resources. Persist
 *   failures are logged and never fail the destroy. Every persisted
 *   destroy snapshot CLEARS `outputs` (and drops `imports` / `outputReads`)
 *   so a partial-destroy state never advertises an export / import whose
 *   backing resource is gone — the in-memory `state` the strong-ref check
 *   above reads is untouched.
 * - On full success, deletes the state file. On any failure, the state
 *   file is preserved (trimmed to the remaining resources, outputs/imports
 *   cleared) so the user can retry.
 */
export async function runDestroyForStack(
  stackName: string,
  state: StackState,
  ctx: DestroyRunnerContext
): Promise<DestroyRunnerResult> {
  const stackRegion = state.region;
  if (!stackRegion || stackRegion === ctx.baseRegion) {
    return destroyStackInRegion(stackName, state, ctx, undefined);
  }
  // go-to-k/cdkd#4941: a stack recorded in another region is destroyed inside
  // a stack AWS scope for that region, as deploy and rollback run theirs, and
  // its nested children get the same clients and registry. A provider that
  // builds its own SDK client captures `ambientRegion()` when it is
  // constructed, so the caller's registry (built in the CLI's region) would
  // delete a nested child's resource by name in the CLI's region: a same-named
  // resource cdkd does not manage there, irreversibly. The child runs with
  // the parent's region as its base, so it never switches on its own, and
  // reads its registry and clients from the nested context the CALLER set.
  // Both are only constructed here; the registry is populated where the runner
  // switches region, after its refusals and the prompt, as before.
  const scopeClients = new AwsClients({
    region: stackRegion,
    ...(ctx.profile && { profile: ctx.profile }),
  });
  try {
    const awsScope = { region: stackRegion, clients: scopeClients };
    const nestedContext = getCurrentNestedStackContext();
    return await runInStackAwsScope(awsScope, () => {
      // Constructed INSIDE the scope (go-to-k/cdkd#5115): the registry's own
      // constructor builds its Cloud Control and custom-resource fallbacks,
      // which capture `getAwsClients()` there. Outside it they took the CLI
      // region's clients, and every Cloud Control-routed delete was refused.
      const registry = new ProviderRegistry();
      const destroyInScope = (): Promise<DestroyRunnerResult> =>
        destroyStackInRegion(stackName, state, ctx, { clients: scopeClients, registry });
      return nestedContext === undefined
        ? destroyInScope()
        : withNestedStackContext(
            { ...nestedContext, providerRegistry: registry, awsClients: scopeClients },
            destroyInScope
          );
    });
  } finally {
    // After `destroyStackInRegion` restored the process-global clients, so no
    // later consumer reaches a destroyed client (issue #2161).
    try {
      scopeClients.destroy();
    } catch (destroyError) {
      getLogger().debug(
        `Failed to destroy region-scoped AWS clients: ${describeAwsFailure(destroyError).detail}`
      );
    }
  }
}

async function destroyStackInRegion(
  stackName: string,
  state: StackState,
  ctx: DestroyRunnerContext,
  stackScope: StackRegionScope | undefined
): Promise<DestroyRunnerResult> {
  // Awaited first, so provider construction below stays synchronous once the
  // stack client scope / globals are set (see `loadProviderClasses`).
  const providerClasses = await loadProviderClasses();
  const logger = getLogger();
  const result: DestroyRunnerResult = {
    stackName,
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 0,
    retainedCount: 0,
    skippedCount: 0,
    guardIndeterminateCount: 0,
    journaledOrphanSkips: 0,
    stateDeleted: false,
    blockedCount: 0,
    errorCount: 0,
    interrupted: false,
  };

  // Region is load-bearing on the new state-key layout (PR 1). Fall back to
  // the caller's baseRegion only for legacy `version: 1` records that never
  // recorded one. Resolved HERE, above the two refusals, because both name the
  // record they refuse and neither may be reached with the count already taken.
  const regionForState = state.region ?? ctx.baseRegion;
  // go-to-k/cdkd#4705: started now, awaited before anything is deleted or
  // prompted for. Never rejects.
  const crossPrefixScan = ctx.crossPrefixCheck?.cache.full(stackName, regionForState);
  // The account every pasteable command in the malformed-record refusals below
  // must address (go-to-k/cdkd#3909): without it the `cdkd state show` /
  // `cdkd state list --json` lines they print read the DEFAULT profile's
  // bucket, so under `--state-bucket X` the record the operator needs is not
  // listed. The refusal module gates each value; nothing is sanitized here.
  const refusalRecovery: LockRecoveryContext = {
    profile: ctx.profile,
    stateBucket: ctx.stateBucket,
    statePrefix: ctx.statePrefix,
  };
  // The lock BOTH sites below take — the empty-state cleanup and the main
  // destroy — through `stack-lock-guard.ts` (go-to-k/cdkd#2174).
  const stackLockBase = {
    lockManager: ctx.lockManager,
    stackName,
    region: regionForState,
    operation: 'destroy',
    recovery: refusalRecovery,
  };
  const journaledOrphans = await refuseMalformedRecordAndLoadJournaledOrphans({
    state,
    stackName,
    regionForState,
    refusalRecovery,
    ctx,
    logger,
    stackLockBase,
  });
  const resourceCount = Object.keys(state.resources).length;
  // A stack that still has `DeletionPolicy: Retain` resources standing in AWS
  // is NOT empty (issue #2934), even with no rows in `resources`. The record of
  // them is the only thing that lets a later deploy re-adopt them instead of
  // colliding with the deterministic names they hold, and the fast path below
  // deletes state.json with no confirmation at all — in exactly the
  // first-deploy-fails flow that produces this shape.
  const orphanCount = (state.orphans ?? []).length;
  // go-to-k/cdkd#5111: a replacement's old resource still to delete keeps the
  // record from being empty, as an orphan does -- and so does a row cdkd
  // cannot read, which may name one (`holdsSupersededResources`).
  const supersededCount = supersededResourcesOf(state).length;
  // AT THE TOP OF THE DESTROY, and REFUSE rather than repair (issue #3207).
  //
  // `parseStateBody` validates the root object and the schema version and
  // nothing inside, so a hand-edited or truncated record reaches this function
  // with `outputs` holding a string, a list, a number, a boolean or `null`. The
  // only thing this runner does with the bag is the strong-reference decision
  // below (`Object.keys(state.outputs).length > 0`), and BOTH answers are
  // fabricated on such a record — a string invents six export names, a `null`
  // reads as "exports nothing" and SKIPS the cross-stack scan entirely. Reading
  // the bag as empty, which is the read-only repair, IS that second answer, so
  // there is no repair available here: see
  // `malformedDestroyOutputsRefusalMessage`.
  //
  // Here rather than beside the decision so no later read of `state` in this
  // function can be reached with an unreadable bag — the placement rule
  // `repairMalformedResourcesForReadOnly`'s note records. It dominates all
  // THREE callers (`cdkd destroy`, `cdkd state destroy`, and
  // `NestedStackProvider.delete`'s child destroy), none of which reads the bag
  // before handing the record over.
  //
  // The `resources` bag is a separate container with a separate absence rule,
  // refused separately just above (go-to-k/cdkd#3161) so the message a user
  // sees names the container that is actually broken.
  refuseMalformedOutputsForDestroy(state, stackName, regionForState, refusalRecovery);
  if (crossPrefixScan) {
    applyCrossPrefixScan(
      await crossPrefixScan,
      {
        stackName,
        region: regionForState,
        bucket: ctx.stateBucket,
        recovery: { profile: ctx.profile, stateBucket: ctx.stateBucket },
      },
      'destroy',
      (message) => logger.warn(message),
      (message) => logger.info(message)
    );
  }
  if (
    resourceCount === 0 &&
    orphanCount === 0 &&
    !holdsSupersededResources(state) &&
    journaledOrphans.count === 0
  ) {
    return destroyEmptyStack({
      stackName,
      ctx,
      logger,
      stackLockBase,
      regionForState,
      refusalRecovery,
      journaledOrphans,
      result,
    });
  }

  // Strong-reference check (schema v4): refuse to destroy if any other
  // stack's `state.imports[]` still references this stack's outputs via
  // Fn::ImportValue. Matches CloudFormation's behavior of rejecting
  // DeleteStack for an exporter while an importer exists.
  //
  // Scans state.json directly rather than trusting the exports index —
  // a stale index could miss a freshly-recorded consumer and we MUST
  // not let strong-ref bypass on perf-only data. The scan only fires
  // when the stack has at least one output (= might be a producer);
  // export-less stacks short-circuit at the `outputs` length check.
  //
  // This is the PRE-FLIGHT scan — fast-fails before the user is
  // prompted to confirm a destroy that would only be refused after the
  // prompt. A second LOCK-PROTECTED scan runs further down (right after
  // we acquire the producer's lock, see below) to tighten the TOCTOU
  // window against a consumer that started deploying between the
  // pre-flight and the actual delete. Even the lock-protected scan has
  // a small residual race against a brand-new consumer deploy that
  // starts AND saves its imports[] entirely between the lock-protected
  // scan and the producer's per-resource delete loop; per-stack locks
  // can't cover cross-stack reads. This race is documented in
  // docs/cross-stack-references.md and matches the same inherent
  // limitation in CloudFormation's own strong-reference enforcement.
  const needsStrongRefCheck = !!(state.outputs && Object.keys(state.outputs).length > 0);
  if (needsStrongRefCheck) {
    const consumers = await scanActiveConsumers(stackName, regionForState, ctx);
    if (consumers.length > 0) {
      throw new StackHasActiveImportsError(stackName, regionForState, consumers);
    }
  }

  logger.info(`\nResources to be deleted (${resourceCount}):`);
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    // Sanitized for the reason the orphan listing below it is, and this half
    // matters MORE: these resources really are deleted once the operator answers
    // y (go-to-k/cdkd#3641 security review). Both values come from a state
    // record, `ConsoleLogger` sanitizes extra ARGS and never the message, and a
    // `resources` key carrying a newline forges rows and a fake orphan tally into
    // the very banner the y/N answers, while an ESC run in a `resourceType`
    // redraws the lines above it.
    logger.info(`  - ${displaySafe(logicalId)} (${displaySafe(resource.resourceType)})`);
  }
  // go-to-k/cdkd#5111: deleted after the resources above.
  if (supersededCount > 0) {
    logger.info(safeMsg`\nOld resources a replacement left to delete (${supersededCount}):`);
    for (const entry of supersededResourcesOf(state)) {
      logger.info(safeMsg`  - ${entry.logicalId} (${entry.state.resourceType}), superseded`);
    }
  }

  // When `--remove-protection` is set, surface a count of resources that
  // appear protected per cdkd state so the prompt names the side effect
  // explicitly. This is a best-effort signal — the real authority is
  // AWS's current state, but at confirm time we only have what cdkd
  // recorded. Resources whose state doesn't carry the protection flag
  // (or where the recorded value is `false`) are still flipped via the
  // idempotent flip-off call inside each provider's `delete()`.
  const protectedCount = ctx.removeProtection
    ? countProtectedResources(state) +
      countProtectedJournaledOrphans(journaledOrphans, state.region)
    : 0;

  // Resources an earlier rollback left in AWS (issue #2934). Destroying this
  // stack deletes the state file, and with it the ONLY record that those
  // resources exist and were once cdkd's — after which nothing here can find
  // them again. They are not deleted by the destroy (they are not in
  // `resources`), so this is the last moment a user can be told.
  //
  // Listed BEFORE the prompt, and OUTSIDE the `skipConfirmation` guard, so it
  // is part of what the `y/N` answers AND still reaches a `--yes` / `--force`
  // run and a nested-stack child (which the parent invokes with
  // `skipConfirmation: true`). A flagged run has declined to be ASKED, not to
  // be told that live resources stop being tracked.
  // go-to-k/cdkd#3869: the stack's `NoEcho` values, re-bound once from the
  // synthesized template (none under `cdkd state destroy`), judge the journal
  // listing below and every delete's printing bag: a record or journal entry
  // written before schema v11 holds such a value in plaintext, which nothing
  // in it marks as secret. Started on first use (a listing, or once the run
  // is confirmed), so a declined run binds nothing it does not print; it never
  // rejects, a synchronous throw included. Capped at
  // NOECHO_PRINTING_BIND_CAP_MS (an SSM-typed parameter's lookup can hang
  // before the prompt and under the lock): past it the run warns and goes on
  // record-only, as `cdkd state destroy` judges, but only while the binding
  // is still pending: a later call (the deletes, after a slow prompt) takes
  // the binding's value once it settles.
  let binding:
    | { bound: Promise<RecordedSecretValues | undefined>; capped: Promise<undefined> }
    | undefined;
  const stackNoEchoValues = (): Promise<RecordedSecretValues | undefined> => {
    if (binding === undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(
            safeMsg`The stack's NoEcho values were not bound within ${NOECHO_PRINTING_BIND_CAP_MS / 1000}s, ` +
              `so a resource name taken from one may print unmasked where state holds it in plaintext ` +
              `(state written before schema v11).`
          );
          resolve(undefined);
        }, NOECHO_PRINTING_BIND_CAP_MS);
        timer.unref?.();
      });
      const bound = Promise.resolve()
        .then(() => ctx.noEchoReresolver?.printingNoEchoValues())
        .catch(() => undefined)
        .finally(() => clearTimeout(timer));
      binding = { bound, capped };
    }
    // Each call races afresh, the binding FIRST: once both have settled,
    // `Promise.race` takes the first in order, so a binding that settled after
    // an earlier call's cap still wins.
    return Promise.race([binding.bound, binding.capped]);
  };
  const cancelled = await announceOrphansAndConfirm({
    state,
    logger,
    stackNoEchoValues,
    journaledOrphans,
    ctx,
    stackName,
    resourceCount,
    protectedCount,
    result,
  });
  if (cancelled !== undefined) return cancelled;

  // Switch region if stack was deployed to a different one. The clients and
  // the (still empty) registry are `runDestroyForStack`'s, which entered the
  // stack AWS scope this runs in and tears the clients down; the
  // process-global switch below is kept for code outside that scope's reach.
  const stackRegion = state.region;
  let destroyProviderRegistry = ctx.providerRegistry;
  let destroyAwsClients: AwsClients | undefined;
  // Set the moment `AWS_REGION` is switched, so the restore below runs even
  // when the switch is only PARTIAL — a throw while populating the
  // region-scoped provider registry leaves the env vars switched (issue #2161).
  let regionSwitched = false;
  // Restore the process-global region + AWS clients this function switched
  // (below) for a cross-region stack. Called from the main `finally` AND from
  // every exit BEFORE that `finally`'s `try` is entered — the cross-region
  // setup below, the lock-acquisition failure, and the strong-ref refusal
  // (issue #2161) — without it, ordinary lock contention (or any pre-lock
  // failure) on a cross-region destroy would leave `AWS_REGION` / the global
  // client pointed at the target stack for the rest of a `--all` run.
  // Idempotent: `regionSwitched` is claimed (cleared) FIRST, so a repeated
  // call — the success path reaches it from the main `finally` after an exit
  // path may already have run it — is a clean no-op. The clients are
  // `runDestroyForStack`'s to destroy, after this restore.
  const restoreBaseRegionAndClients = (): void => {
    if (!regionSwitched) return;
    regionSwitched = false;
    destroyAwsClients = undefined;
    process.env['AWS_REGION'] = ctx.baseRegion;
    process.env['AWS_DEFAULT_REGION'] = ctx.baseRegion;
    setAwsClients(ctx.baseAwsClients);
  };
  if (stackScope !== undefined && stackRegion) {
    logger.info(`Stack region: ${displaySafe(stackRegion, { asciiOnly: true })}`);
    process.env['AWS_REGION'] = stackRegion;
    process.env['AWS_DEFAULT_REGION'] = stackRegion;
    regionSwitched = true;

    try {
      destroyAwsClients = stackScope.clients;
      setAwsClients(destroyAwsClients);

      // Populated HERE, inside the stack AWS scope `runDestroyForStack`
      // entered, so every provider captures the stack's region; the nested
      // context already holds this same registry (go-to-k/cdkd#4941).
      destroyProviderRegistry = stackScope.registry;
      registerAllProviders(destroyProviderRegistry, providerClasses);
      destroyProviderRegistry.setCustomResourceResponseBucket(ctx.stateBucket);
      if (ctx.allowUnsupportedTypes?.length) {
        destroyProviderRegistry.allowUnsupportedTypes(ctx.allowUnsupportedTypes);
      }
    } catch (setupError) {
      // A failure here is before the main try/finally too, so restore the
      // (possibly partial) region/client switch rather than leaking it.
      restoreBaseRegionAndClients();
      throw setupError;
    }
  }

  return destroyStackUnderLock({
    stackName,
    state,
    ctx,
    logger,
    result,
    regionForState,
    refusalRecovery,
    stackLockBase,
    journaledOrphans,
    needsStrongRefCheck,
    stackNoEchoValues,
    destroyProviderRegistry,
    destroyAwsClients,
    restoreBaseRegionAndClients,
  });
}
