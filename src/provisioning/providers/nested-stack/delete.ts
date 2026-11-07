import type { NestedStackProvider } from '../nested-stack-provider.js';
import {
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
} from '../../../utils/pasteable-command.js';
import type { ResourceDeleteResult, DeleteContext } from '../../../types/resource.js';
import { runDestroyForStack } from '../../../cli/commands/destroy-runner.js';
import {
  accountArgs,
  refuseMalformedResourcesForDestroy,
  withheldAccountClause,
} from '../../../state/malformed-resources-bag.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../nested-stack-context.js';
// Leaf module by design — see the note in nested-stack-messages.ts: importing
// this builder from anywhere on the provider/destroy-runner ring re-creates the
// cycle it was extracted to break.
import { nestedStackChildFailureMessage } from '../../nested-stack-messages.js';
// `retryable-errors.ts` is a graph LEAF (its family's only outside import is
// the zero-import `aws-failure-text.ts`), so importing it here
// cannot close a cycle — which is also why the marker cannot live in
// `nested-stack-messages.ts` instead: that module is required to stay
// import-free (its own header says so), so the mark belongs at the THROW
// SITE. Throw-site rather than constructor shape is right for a second
// reason too: the errors below are plain `Error`s, and — unlike
// `ResourceUpdateNotSupportedError` — the class raised here is NOT a refusal
// in every instance (see the per-arm note at the `errorCount` throw).
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { displaySafe } from '../../../utils/display-safe.js';
import { runAccountOf } from './shared.js';

export async function deleteImpl(
  this: NestedStackProvider,
  logicalId: string,
  _physicalId: string,
  _resourceType: string,
  _properties?: Record<string, unknown>,
  deleteContext?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  const ctx = this.requireContext();
  const childStackName = this.deriveChildStackName(ctx.parentStackName, logicalId);
  const childRegion = ctx.parentRegion;

  // Treat a missing child state file as idempotent success — the child
  // was never deployed or was already destroyed out-of-band. Mirrors
  // every other provider's "not found = already gone" delete semantic.
  //
  // Load-bearing assumption: `S3StateBackend.getState` returns `null`
  // ONLY on a 404 (NoSuchKey) and throws on every other failure class
  // (auth / IAM / network / 5xx). A future refactor that swallows those
  // error classes and returns `null` would silently mask real failures
  // here and leave orphan AWS resources behind — re-verify the backend
  // contract before changing its null-return semantics.
  const childStateData = await ctx.stateBackend.getState(childStackName, childRegion);
  if (!childStateData) {
    this.logger.debug(
      `Nested stack ${displaySafe(childStackName)} has no state — treating delete as idempotent success.`
    );
    return;
  }

  // ABOVE the count, for the reason `runDestroyForStack`'s own guard is
  // (issue go-to-k/cdkd#3161). That runner refuses an unreadable `resources`
  // bag, but this line reads the CHILD's bag one call EARLIER — so a child
  // record holding `null` or no `resources` at all still died here on the
  // bare `TypeError` the guard exists to remove, and a `[]` / number /
  // boolean logged `0 resource(s)` before the runner got to say otherwise.
  // Same helper, so the child's refusal reads identically to a top-level
  // one — and the same account flags the child's runner is handed below, so
  // its pasteable commands read the bucket this run read (go-to-k/cdkd#3909).
  refuseMalformedResourcesForDestroy(
    childStateData.state,
    childStackName,
    childRegion,
    runAccountOf(ctx)
  );
  const resourceCount = Object.keys(childStateData.state.resources).length;
  this.logger.info(
    `Destroying nested stack ${displaySafe(childStackName)} (logicalId=${displaySafe(logicalId)}, ${resourceCount} resource(s))`
  );

  // Switch the ALS context so any grandchildren the child contains
  // resolve against the right "parent" (the child) when their own
  // NestedStackProvider.delete fires from inside runDestroyForStack.
  const childCtx: NestedStackProviderContext = {
    ...ctx,
    parentStackName: childStackName,
    parentRegion: childRegion,
    nestedTemplates: undefined,
    // A row's report slot never crosses a nesting boundary (issue #1989).
    childUnaddressed: undefined,
  };

  // go-to-k/cdkd#4682: a `cdkd destroy` holding the parent's template
  // re-resolves the child's NoEcho coordinates from the child's template
  // and the parameters this row hands it. Absent on a deploy's removal.
  const childNoEchoReresolver =
    deleteContext?.noEchoReresolver === undefined
      ? undefined
      : await deleteContext.noEchoReresolver.forNestedChild(
          logicalId,
          {
            properties: _properties,
            noEchoLeaves: deleteContext.recordedNoEchoLeaves,
            values: deleteContext.noEchoDeleteValues,
          },
          childStackName,
          (templatePath) => {
            const { template, grandchildTemplates } = this.readChildTemplate(templatePath);
            return { template, nestedTemplates: grandchildTemplates };
          },
          (properties) => this.extractParameters(properties)
        );

  const childResult = await withNestedStackContext(childCtx, () =>
    runDestroyForStack(childStackName, childStateData.state, {
      stateBackend: ctx.stateBackend,
      lockManager: ctx.lockManager,
      providerRegistry: ctx.providerRegistry,
      baseAwsClients: ctx.awsClients,
      baseRegion: childRegion,
      // `getState` adopted the KEY's region into the child record above, so
      // this is the only place the divergence is still visible; the runner
      // refuses on it when the child still lists resources (issue #3328).
      // A cascading destroy is the case that most needs it: the parent has
      // already confirmed, and nothing else asks about this child.
      ...(childStateData.divergentBodyRegion !== undefined && {
        divergentBodyRegion: childStateData.divergentBodyRegion,
      }),
      stateBucket: ctx.stateBucket,
      // Parent has already confirmed the cascading destroy — children
      // are not separately confirmable per design §7.
      skipConfirmation: true,
      ...(ctx.exportIndexStore && { exportIndexStore: ctx.exportIndexStore }),
      ...(ctx.destroyOptions?.profile && { profile: ctx.destroyOptions.profile }),
      ...(ctx.destroyOptions?.statePrefix !== undefined && {
        statePrefix: ctx.destroyOptions.statePrefix,
      }),
      ...(deleteContext?.removeProtection === true && { removeProtection: true }),
      // go-to-k/cdkd#4150: forwarded ONLY from this delete's own context,
      // which a top-level destroy sets and a deploy's nested-stack removal
      // never does (its template-removal DELETE runs after every CREATE).
      // The parent's producer regions go down with it: a child receives a
      // parent's cross-region value only as a Parameter, which its own
      // state does not record as a read. go-to-k/cdkd#4887: so does the
      // marker that those regions miss an ancestor's (this child was
      // destroyed on its own), or the grandchild would read them as complete.
      ...(deleteContext?.resolveSecretDerivedPrincipals !== undefined && {
        resolveSecretDerivedPrincipals: {
          inheritedProducerRegions:
            deleteContext.resolveSecretDerivedPrincipals.importedProducerRegions,
          ...(deleteContext.resolveSecretDerivedPrincipals.producerRegionsIncomplete === true && {
            producerRegionsIncomplete: true,
          }),
        },
      }),
      // go-to-k/cdkd#2115: likewise forwarded ONLY from this delete's own
      // context. A nested child of a real stack destroy inherits it; one a
      // deploy removes stays on the deploy-side warn-and-drop, since
      // CloudFormation ignores delete failures in an update's cleanup phase.
      ...(deleteContext?.stackDestroy === true && { stackDestroy: true }),
      // go-to-k/cdkd#2346: only `cdkd state destroy` sets it, so the child's
      // earlier record versions go with the parent's on that path alone.
      ...(ctx.destroyOptions?.purgeStateHistory === true && { purgeStateHistory: true }),
      ...(childNoEchoReresolver !== undefined && { noEchoReresolver: childNoEchoReresolver }),
      // `--skip-final-snapshot` reaches a whole-nested-stack removal from
      // BOTH directions: `cdkd destroy` / `state destroy` thread it via
      // ctx.destroyOptions, while `cdkd deploy` (template-removal delete of
      // the nested-stack row) only sets ctx.options (the parent's
      // DeployEngineOptions) — reviewer catch on issue #1352.
      ...((ctx.destroyOptions?.skipFinalSnapshot === true ||
        ctx.options?.skipFinalSnapshot === true) && { skipFinalSnapshot: true }),
      ...(ctx.destroyOptions?.resourceWarnAfterMs !== undefined && {
        resourceWarnAfterMs: ctx.destroyOptions.resourceWarnAfterMs,
      }),
      ...(ctx.destroyOptions?.resourceTimeoutMs !== undefined && {
        resourceTimeoutMs: ctx.destroyOptions.resourceTimeoutMs,
      }),
      ...(ctx.destroyOptions?.resourceWarnAfterByType && {
        resourceWarnAfterByType: ctx.destroyOptions.resourceWarnAfterByType,
      }),
      ...(ctx.destroyOptions?.resourceTimeoutByType && {
        resourceTimeoutByType: ctx.destroyOptions.resourceTimeoutByType,
      }),
    })
  );

  // Issue #1752: the child runner reports a resource it could NOT address
  // (no AWS call issued, the resource may still be alive) as `skippedCount`.
  // Swallowing that here re-creates the very mis-report the issue is about,
  // one level up: the PARENT would print `✓ <Child> (AWS::CloudFormation::Stack)
  // deleted`, drop the child's row from parent state, and exit 0 — while the
  // child's own state.json is sitting there preserved, describing a live
  // resource nobody will ever look for again. Propagating the skip makes the
  // parent preserve its own state too, so the whole tree stays traceable.
  //
  // `interrupted` (a graceful SIGINT mid-child, issue #816) is the SAME
  // data-loss shape reached through a different field: the child stops early
  // and preserves its own state.json listing resources that still exist,
  // while the parent — with no signal — prints `✓ <Child> deleted`, drops the
  // child's row, and exits 0. It is reported as a skip for the same reason:
  // the child stack was NOT destroyed, so the parent's record of it must
  // survive. A skip rather than a throw is right for it because NOTHING
  // failed — the run is already ending non-zero (the runner sets
  // `interrupted` on the parent too, and both CLIs raise PartialFailureError
  // for it), so this changes what SURVIVES, not whether the command fails,
  // and an interrupt is a user-requested stop rather than a failure.
  //
  // `errorCount` is the THIRD field saying "this child stack is NOT gone",
  // and it is the only one whose honest answer is a THROW rather than a skip
  // (issue [#1777](https://github.com/go-to-k/cdkd/issues/1777)). A resource
  // inside the child was ATTEMPTED and FAILED — so the parent's
  // `AWS::CloudFormation::Stack` row must FAIL too, exactly as a failed
  // delete of any other resource type does. Reporting it as a skip would be
  // a lie in the other direction (a skip means no AWS call was issued), and
  // swallowing it was the pre-#1777 behavior: the parent printed
  // `✓ <Child> deleted`, dropped the child's row AND — with its own
  // `errorCount` still 0 — deleted the parent's `state.json` and the exports
  // index outright, exiting 0 over a child whose preserved state.json
  // describes live resources. Throwing keeps the row, preserves the parent's
  // state, and surfaces a non-zero exit.
  //
  // This is deliberately a BEHAVIOR CHANGE, and it reaches BOTH callers of
  // `delete`. A `{ outcome: 'skipped' }` return value reaches both too since
  // issue #1762 — but it is deliberately WEAKER there (the deploy's
  // template-removal DELETE warns and keeps the record), whereas a child that
  // FAILED must fail its parent's row on either path:
  //   - `cdkd destroy` / `cdkd state destroy` — the parent's nested-stack row
  //     now fails (exit 2) where it previously reported the child deleted;
  //   - `cdkd deploy` — REMOVING a nested stack from the template routes the
  //     row through the deploy engine's DELETE path, so a child that fails to
  //     destroy now fails the DEPLOY (and triggers its rollback) where it
  //     previously recorded the row as deleted and carried on.
  // The deploy-side reach is the wider half of the blast radius; it is the
  // same correctness argument, but it turns a silent success into a failed
  // deploy rather than a failed destroy.
  // Issue #1849: this message interpolates `childStackName`
  // (`<parent>~<childLogicalId>`), which is fully user-controlled, and
  // `retryable-errors.ts` classifies by SUBSTRING —
  // `DependencyViolation` being a whitespace-free entry in
  // `RETRYABLE_ERROR_MESSAGE_PATTERNS` (it was the ONLY one until issue
  // #2116 added the name-cooldown error CODES `QueueDeletedRecently` /
  // `StateMachineDeleting`, so the hazard is wider now, not narrower), a
  // nested stack whose logical id
  // merely CONTAINS it makes a cdkd-authored message look transient. The
  // remedy is `markNonRetryable`, which is consulted BEFORE any message
  // heuristic, and BOTH arms carry it (go-to-k/cdkd#1889):
  //
  //  - Interrupted: the child stopped early because the user pressed
  //    Ctrl-C, and a retry would start a FRESH child destroy with the
  //    interrupt forgotten (`destroy-runner.ts` reads `lock.interrupted`
  //    from a per-INVOCATION stack-lock guard) — resuming work the user
  //    just aborted.
  //  - NOT interrupted: a whole-child re-destroy COULD heal a resource that
  //    was still draining, but no caller retries this provider's `delete()`
  //    — it sets `disableOuterRetry`, so `destroy-runner.ts` computes
  //    `maxAttempts = 0` and `DeployEngine.withRetry` short-circuits — so
  //    leaving it unmarked bought no retry. What it DID buy was the
  //    "already deleted" misread: both delete callers drop the state row
  //    when an UNMARKED message contains `NotFoundException` / `not found`,
  //    and the child name interpolated here is template-controlled (a
  //    child logical id `HandleNotFoundException` dropped the parent's row
  //    while the child state survived). The marker is what those guards
  //    read, so it closes that hole without touching them.
  if (childResult.errorCount > 0) {
    // The run's account flags (go-to-k/cdkd#4648), so the pasted command
    // reads the child record in the bucket this destroy read.
    const account = runAccountOf(ctx);
    const accountClause = withheldAccountClause(account, 'the command below prints').trimEnd();
    const inspect = pasteableCommand('cdkd state show', [
      { value: childStackName, hole: 'stack', opts: { plainIdent: true } },
      ...accountArgs(account),
    ]);
    const failure = new Error(
      nestedStackChildFailureMessage(
        // Both built HERE because the message module is a leaf by design.
        // The child name sits beside a labelled line, so the prose names it
        // and the command carries it only when it is a plain identifier —
        // a padded logical id could otherwise wrap into a counterfeit
        // `Inspect it with:` row (go-to-k/cdkd#3759).
        plainOrDescribed(childStackName, 'stack name'),
        childResult.errorCount,
        childResult.skippedCount,
        childResult.interrupted,
        inspect.command,
        withheldTargetClause(inspect, 'stack', 'cdkd state show', "The child stack's name") +
          (accountClause === '' ? '' : ` ${accountClause}`)
      )
    );
    throw markNonRetryable(failure);
  }

  // go-to-k/cdkd#4738: a skip that is a journaled orphan keeps no record, so
  // a child whose only skips are those deletes its own state. On a stack
  // destroy its row is gone, not kept: report it deleted, the orphans named
  // in `leftInPlace` and their count in the destroy runner's slot, so the
  // run still exits 2. Gated on the runner's own `stateDeleted`, never on a
  // re-derivation of its preserve decision, so the row cannot be dropped
  // while the child's state survives. A deploy's removal and a rollback
  // keep the `skipped` below: their callers neither count a slot on a
  // delete nor print `leftInPlace`, and their re-run finds the child state
  // gone, a success.
  const orphanSkips = childResult.journaledOrphanSkips;
  if (deleteContext?.stackDestroy === true && childResult.stateDeleted && orphanSkips > 0) {
    // A `stackDestroy: true` caller must bind this slot
    // (`collectNestedChildUnaddressed`, as the destroy runner does around
    // every delete): without it the count is not surfaced and the run can
    // exit 0 over the resources left in AWS.
    const slot = ctx.childUnaddressed;
    if (slot) slot.last = { deleteSkipped: orphanSkips, updatePartial: 0 };
    return {
      outcome: 'deleted',
      leftInPlace:
        `nested stack ${plainOrDescribed(childStackName, 'stack name')} left ${orphanSkips} ` +
        `resource(s) a failed deploy created in AWS`,
    };
  }

  if (childResult.skippedCount > 0 || childResult.interrupted) {
    const causes: string[] = [];
    if (childResult.skippedCount > 0) {
      causes.push(`skipped ${childResult.skippedCount} resource(s)`);
    }
    if (childResult.interrupted) causes.push('was interrupted');
    return {
      outcome: 'skipped',
      // As the partial reason above (go-to-k/cdkd#4265).
      reason: `nested stack ${plainOrDescribed(childStackName, 'stack name')} ${causes.join(' and ')}`,
    };
  }
}
