import { prepareCreateRollbackFinalSnapshot } from './names.js';
import { safe, effectiveProvisionedBy, throwIfDeleteSkipped } from './messages.js';
import type { ReplayOpScope } from './replay-scope.js';
import { noteRetainedResource } from '../../provisioning/providers/create-token-ledger.js';

/** `replaySingle`'s 'orphan-flag' arm (#4426). */
export async function replayOrphanFlag(s: ReplayOpScope): Promise<void> {
  const { op, stateResources, stackName, ctx, afterOp, logger, mask } = s;
  if (op.changeType === 'CREATE') {
    // --orphan on a CREATE: leave the resource in AWS, drop it from
    // state (it is not part of the pre-deploy baseline).
    //
    // Bound BEFORE the delete, and the ONLY source for both the route
    // and the id below. Route resolution already read the record here
    // (issue #1366, so both orphan triggers resolve `provisionedBy` the
    // same way); the id used to read `op` instead, which made this arm
    // internally inconsistent about which side it trusted.
    //
    // Load-bearing for the id specifically, because `orphan-flag` is NOT
    // reachable-only-past-the-checks the way `orphan-retain` is:
    // `classifyRollbackOp` returns it from a short-circuit ABOVE the
    // CREATE branch, so it skips both `skip-already-done` (no record)
    // and `skip-mismatch` (record id != op id) -- and
    // `orphanLogicalIds` is RAW CLI INPUT, never validated against
    // state. Publishing `op.physicalId` unconditionally therefore
    // asserted "live, still billing" about an id that may be DELETED (a
    // re-run of an already-orphaned op) or STALE (a later attempt moved
    // the id, and the real survivor would be named nowhere). For a
    // name-reusable type a deleted id may by then belong to someone
    // else's resource, which is the worst thing a cleanup pass could be
    // handed.
    const record = stateResources[op.logicalId];
    const orphanFlagProvisionedBy = effectiveProvisionedBy(record, op.provisionedBy);
    s.createRollbackRoute = orphanFlagProvisionedBy;
    // Drops a state row beside the `afterOp` save below and mints NO
    // record, deliberately (issue #2934): `--orphan` is the user saying
    // "leave this one alone" about a rollback stuck on it, not a
    // `DeletionPolicy`, so re-adopting it on the next deploy would
    // contradict the instruction. The two Retain arms are the only
    // minters.
    delete stateResources[op.logicalId];
    // go-to-k/cdkd#4438: the orphaned resource still holds this stack's
    // create token, so the stack's next create of it must not send it again.
    await noteRetainedResource(op.resourceType, op.logicalId);
    logger.info(`  Rollback: Orphaning created resource ${safe(op.logicalId)} (--orphan)`);
    await afterOp?.(op.logicalId);
    // Emit the same rollback event as the DeletionPolicy-orphan path
    // (`orphan-retain`) so `cdkd events` surfaces the orphaned resource
    // consistently regardless of which orphan trigger fired.
    ctx.recordEvent?.({
      eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
      stackName,
      operation: 'CREATE',
      logicalId: op.logicalId,
      resourceType: op.resourceType,
      ...(orphanFlagProvisionedBy && { provisionedBy: orphanFlagProvisionedBy }),
      // The survivor's id, same class as the replacement-rollback retain
      // arms and STRICTLY worse without it: this arm drops the state
      // record too, so with no id here NOTHING anywhere names the
      // resource left running in AWS.
      //
      // Gated on the RECORD, not on `op.physicalId` -- see the binding
      // above. No record means nothing was orphaned (the resource is
      // already gone), and then the honest event is one that claims no
      // survivor at all.
      ...(record?.physicalId && {
        physicalId: record.physicalId,
        // The PROSE is masked (issue #4037); the `physicalId` FIELD is the
        // cleanup datum and stays exact, like the record `state.json`
        // itself holds in the same bucket.
        reason: mask(
          `--orphan left ${op.logicalId} (${op.resourceType}) in AWS as ` +
            `${record.physicalId} and dropped it from state; it is live, still billing, ` +
            `and no longer tracked by cdkd.`
        ),
      }),
    });
  } else {
    // --orphan on an UPDATE: leave the resource at its new properties;
    // keep state as-is so it keeps describing AWS truth.
    logger.info(`  Rollback: Leaving ${safe(op.logicalId)} at its new state (--orphan)`);
  }
  return;
}

/** `replaySingle`'s 'orphan-retain' arm (#4426). */
export async function replayOrphanRetain(s: ReplayOpScope): Promise<void> {
  const { op, stateResources, stackName, ctx, result, onOrphan, afterOp, logger, mask } = s;
  // DeletionPolicy Retain on a rolled-back CREATE: orphan instead of
  // delete (the policy says KEEP the resource). `Snapshot` used to
  // land here too — see the module header + issue #1358.
  //
  // Resolved BEFORE the record is dropped: the event reports the
  // resource's effective route (issue #1366), and the record — the
  // authoritative side — is about to go away. The id below reads the
  // SAME binding, so the two halves of this event cannot disagree about
  // which side they trust.
  const record = stateResources[op.logicalId];
  const orphanProvisionedBy = effectiveProvisionedBy(record, op.provisionedBy);
  s.createRollbackRoute = orphanProvisionedBy;
  // Keep what we are about to throw away (issue #2934). cdkd's generated
  // physical names are deterministic, so this resource now holds the
  // exact name the next deploy will ask AWS for — without the record
  // that deploy collides, rolls back, and repeats forever.
  //
  // The RECORD, not a physical id: its `properties` are the failed
  // deploy's resolved TEMPLATE values, which is the shape the diff
  // expects on the old side. Re-adopting from an AWS readback instead
  // would carry keys the template omits (a generated `RoleName`,
  // `BucketName`, ...) and the next diff would read them as removals of
  // create-only properties and REPLACE the resource — destroying the
  // data the adoption exists to preserve.
  //
  // Guarded on `record` because `replayRollback` is idempotent: a replay
  // over an already-reverted segment finds nothing here, and pushing an
  // `undefined` state would mint a record no consumer can act on.
  if (record) {
    const orphaned = { logicalId: op.logicalId, orphanedAt: Date.now(), state: record };
    result.orphaned.push(orphaned);
    // BEFORE the `afterOp` below, which SAVES. Reading `result.orphaned`
    // only after this function returns would let every intermediate save
    // persist the resource's absence with no record of it.
    onOrphan?.(orphaned);
  }
  delete stateResources[op.logicalId];
  // go-to-k/cdkd#4438: the kept resource still holds this stack's create
  // token, so the stack's next create of it must not send it again.
  await noteRetainedResource(op.resourceType, op.logicalId);
  logger.info(
    `  Rollback: Leaving ${safe(op.logicalId)} (${safe(op.resourceType)}) in AWS ` +
      `(DeletionPolicy: Retain) — removed from state`
  );
  await afterOp?.(op.logicalId);
  ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
    stackName,
    operation: 'CREATE',
    logicalId: op.logicalId,
    resourceType: op.resourceType,
    ...(orphanProvisionedBy && { provisionedBy: orphanProvisionedBy }),
    // Same publish as the `--orphan` twin above: the state record is
    // dropped, so this event is the only place the retained resource's
    // id survives.
    //
    // Reads the RECORD, not `op.physicalId`, for a reason that differs
    // from the twin's. This arm IS only reachable past
    // `skip-already-done` / `skip-mismatch`, so its record is present
    // and matching -- the gate is belt-and-braces here. What the record
    // read fixes is the opposite hole: `classifyRollbackOp` only
    // compares the ids when `op.physicalId` is DEFINED, so a journal op
    // carrying none still reaches this arm, and reading `op` there
    // dropped the publish entirely and lost the id the record was
    // holding all along.
    ...(record?.physicalId && {
      physicalId: record.physicalId,
      // Prose masked, field exact: the `--orphan` twin's note.
      reason: mask(
        `DeletionPolicy: Retain left ${op.logicalId} (${op.resourceType}) in AWS as ` +
          `${record.physicalId} and dropped it from state; it is live, still billing, and ` +
          `no longer tracked by cdkd.`
      ),
    }),
  });
  return;
}

/** `replaySingle`'s 'delete' / 'delete-with-final-snapshot' arm (#4426). */
export async function replayDelete(s: ReplayOpScope): Promise<void> {
  const {
    op,
    stateResources,
    stackName,
    ctx,
    result,
    inlinePolicyWriters,
    afterOp,
    action,
    logger,
    mask,
  } = s;
  if (!op.physicalId) {
    logger.warn(`  Rollback: Cannot delete ${safe(op.logicalId)} — no physical ID recorded`);
    result.warnings++;
    return;
  }
  // `DeletionPolicy: Snapshot` (issue #1358): snapshot BEFORE the
  // delete. Deliberately ahead of the delete's own call so a refusal /
  // snapshot failure leaves the resource intact (and counts as a
  // failure, keeping the journal for a re-run) rather than deleting
  // the data the policy promised to preserve. `--skip-final-snapshot`
  // is the explicit data-loss opt-out and degrades to a plain delete.
  //
  // The routing layer is resolved ONCE and used for BOTH the snapshot
  // gate and the provider lookup below: the gate's cc-api refusal is
  // only meaningful if it judges the route the delete will actually
  // take, and the delete-of-the-NEW-resource site already resolves it
  // this way (`current.provisionedBy ?? op.provisionedBy`).
  const deleteProvisionedBy = effectiveProvisionedBy(
    stateResources[op.logicalId],
    op.provisionedBy
  );
  s.createRollbackRoute = deleteProvisionedBy;
  const snapshotPolicy = action === 'delete-with-final-snapshot';
  const takeFinalSnapshot = snapshotPolicy && ctx.skipFinalSnapshot !== true;
  let finalSnapshotIdentifier: string | undefined;
  if (takeFinalSnapshot) {
    finalSnapshotIdentifier = await prepareCreateRollbackFinalSnapshot(
      op,
      deleteProvisionedBy,
      ctx,
      mask
    );
  }
  logger.info(
    `  Rollback: Deleting created resource ${safe(op.logicalId)} (${safe(op.resourceType)})` +
      (takeFinalSnapshot ? ' — DeletionPolicy: Snapshot' : '') +
      // Make the opt-out auditable: without this the line is
      // byte-identical to a plain delete, so neither the log nor
      // `cdkd events` records that a Snapshot-policy resource was
      // destroyed with no snapshot.
      (snapshotPolicy && !takeFinalSnapshot
        ? ' — DeletionPolicy: Snapshot NOT taken (--skip-final-snapshot)'
        : '')
  );
  // Route via the SAME provider the CREATE landed on (#614).
  const { provider } = ctx.providerRegistry.getProviderFor({
    resourceType: op.resourceType,
    provisionedBy: deleteProvisionedBy,
  });
  // go-to-k/cdkd#4225: a name a completed revert of this replay has put
  // back on a principal is not removed by this delete.
  const createRollbackClaimed = inlinePolicyWriters.claimedFor(
    op.resourceType,
    op.logicalId,
    stateResources
  );
  const createRollbackDelete = await provider.delete(
    op.logicalId,
    op.physicalId,
    op.resourceType,
    op.properties,
    {
      expectedRegion: ctx.region,
      ...(createRollbackClaimed && { inlinePolicyClaimed: createRollbackClaimed }),
      ...(finalSnapshotIdentifier !== undefined && { finalSnapshotIdentifier }),
      ...(ctx.skipFinalSnapshot === true && { skipFinalSnapshot: true }),
      // Issue #4029: the classified policy, so a Cloud Control-routed
      // RDS delete under `Delete` avoids the registry handler's snapshot.
      deletionPolicy: snapshotPolicy ? 'Snapshot' : 'Delete',
      // Issue #4157. `classifyRollbackOp` reaches this arm only with a
      // record naming `op.physicalId`.
      recordedAttributes: stateResources[op.logicalId]?.attributes,
    }
  );
  throwIfDeleteSkipped(
    createRollbackDelete,
    op.logicalId,
    op.physicalId,
    'while rolling back its CREATE'
  );
  delete stateResources[op.logicalId];
  logger.info(`  Rollback: ${safe(op.logicalId)} deleted successfully`);
  await afterOp?.(op.logicalId);
  ctx.recordEvent?.({
    eventType: 'ROLLBACK_RESOURCE_SUCCEEDED',
    stackName,
    operation: 'CREATE',
    logicalId: op.logicalId,
    resourceType: op.resourceType,
    // The route the delete ACTUALLY took, not the journaled one
    // (issue #1366) — a legacy journal entry can disagree with the
    // state record, and the record is what the delete was routed by.
    ...(deleteProvisionedBy && { provisionedBy: deleteProvisionedBy }),
  });
  return;
}
