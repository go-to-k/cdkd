import type { CloudControlProvider } from '../cloud-control-provider.js';
import { DeleteResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import {
  ec2InstanceProtectionSite,
  isTerminationProtectionPropagationError,
  observeThenDisableInstanceApiTermination,
  reDisableInstanceApiTermination,
  reEnableInstanceApiTermination,
  TERMINATION_PROTECTION_MAX_ATTEMPTS,
} from '../ec2-termination-protection.js';
import {
  deleteWithProtectionCompensation,
  protectionFlipKey,
  type ProtectionFlipRecord,
} from '../providers/deletion-protection-compensation.js';
import { deleteEc2VolumeDirect } from '../ec2-volume-delete.js';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { withIndeterminateGuard } from '../../deployment/delete-outcome.js';
import { standaloneInlinePolicyHandedOff } from '../../deployment/inline-policy-claims.js';
import { safeMsg } from '../../utils/display-safe.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import type { DeleteContext } from '../region-check.js';
import { ccProtectionProperty, ccProtectionSite } from '../cc-protection-properties.js';
import { slowCcOperationTimeoutMs } from '../slow-cc-operation-timeouts.js';
import type {
  ResourceProvider,
  ResourceDeleteResult,
  IndeterminateGuard,
} from '../../types/resource.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  isTransientPollFailure,
  isCcDeleteGoneError,
  markNotGoneOnNeedle,
} from './poll-failure.js';
import {
  SDK_DELETE_FAMILIES,
  deletesThroughSdkProvider,
  type ProtectedEc2Instance,
  ccDeleteMayHaveActed,
} from './delete-guards.js';
import { IdScrubLog, inIdLogScope, holdsSecretDerivedLeaf } from './id-log.js';
import { CloudControlOperationFailedError } from './shared.js';
import { getAccountInfo } from '../../deployment/intrinsic-function-resolver.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  IPAM_CIDR_HAS_ALLOCATIONS,
  ipamPoolCidrReleaseBudgetMs,
  ipamPoolIdOfPoolCidr,
  MAX_IPAM_RECHECKS,
  waitForLingeringIpamAllocations,
  type IpamReleaseVerdict,
} from '../ipam-pool-cidr-release.js';

/**
 * Delete a resource using Cloud Control API.
 *
 * Runs under an {@link IdScrubLog} (go-to-k/cdkd#3869). The evidence is
 * the bag: a `{{resolve:` reference or `***` there, which is how state keeps
 * a secret leaf, or a plaintext leaf the caller's `DeleteContext.maskSecrets`
 * changes, which is how an in-process rollback's resolved bag shows one
 * (go-to-k/cdkd#2007).
 */
export async function deleteImpl(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  const mask = maskerOrIdentity(context?.maskSecrets);
  const idLog = new IdScrubLog(this.logger, mask, holdsSecretDerivedLeaf(properties, mask));
  idLog.addId(physicalId);
  const result = await inIdLogScope(idLog, () =>
    this.deleteInIdLogScope(logicalId, physicalId, resourceType, properties, context)
  );
  // A guard's `reason` can name the id (`s3:GetBucketLocation on <id> ...`),
  // and the destroy runner persists it as an event and prints it.
  // A skipped result's `reason` can name it too.
  if (!idLog.withheld || !result) return result;
  return {
    ...result,
    ...(result.outcome === 'skipped' && { reason: idLog.scrub(result.reason) }),
    ...(Array.isArray(result.indeterminateGuards) && {
      indeterminateGuards: result.indeterminateGuards.map((guard) => ({
        ...guard,
        reason: idLog.scrub(guard.reason),
      })),
    }),
  };
}

export async function deleteInIdLogScope(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  context: DeleteContext | undefined
): Promise<void | ResourceDeleteResult> {
  this.logger.debug(`Deleting resource ${logicalId} (${resourceType}), physical ID: ${physicalId}`);

  // Fail closed on `DeletionPolicy: Snapshot` (issue #1352): Cloud Control
  // `DeleteResource` has no final-snapshot parameter, so this provider
  // CANNOT honor `finalSnapshotIdentifier`. The destroy call sites already
  // refuse cc-api-routed atomic types before the delete, so this is
  // defense-in-depth against a future call site passing the field to a
  // provider that would silently ignore it — the exact silent data loss
  // the field exists to prevent.
  if (context?.finalSnapshotIdentifier !== undefined) {
    throw new ProvisioningError(
      `${logicalId} (${resourceType}) requires a final snapshot ` +
        `(DeletionPolicy: Snapshot), but the Cloud Control API delete route has no ` +
        `final-snapshot parameter. Re-run with --skip-final-snapshot after snapshotting ` +
        `manually, or retain the resource.`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  // Issue #2301 item 2: the record's region, checked UNCONDITIONALLY and for
  // EVERY Cloud-Control-routed type, before anything below runs.
  //
  // Until this existed, `assertRegionMatch` ran only in the `NotFound` arm of
  // the catch block at the bottom of this method -- which a wrong-region
  // delete usually never reaches. A Cloud Control `Identifier` is most often
  // a NAME, and the same name commonly exists in the client's region too
  // (the same stack deployed to two regions; cdkd's own `resource-name.ts`
  // derives an identical name from an identical stack + logical id). So the
  // delete succeeds -- against the wrong resource, unrecoverably -- and the
  // guard that was supposed to catch it sat on the branch that error never
  // takes. The hardening costs ZERO API calls beyond resolving the client's
  // own configured region, and it is type-INDEPENDENT: unlike
  // `confirmDeleteTargetIdentity` below it is not about S3, the global
  // bucket namespace, or the region redirect.
  //
  // Ordering against the two neighbours here is deliberate. It comes AFTER
  // the `finalSnapshotIdentifier` fail-closed above, which is a pure
  // context-shape refusal needing no I/O, and BEFORE
  // `confirmDeleteTargetIdentity`, which spends a `GetBucketLocation`: when
  // both would refuse, the cheaper and more general answer should win.
  //
  // The `update()` twin is at the top of `update()` (issue #2301 item 1);
  // `UpdateContext` now carries `expectedRegion` for it.
  await this.assertRecordedRegionAgainstClient(
    'pre-delete',
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId
  );

  // go-to-k/cdkd#4821: a standalone inline policy whose (principal, name)
  // another resource of this deploy has ALREADY written (a completed
  // writer, `context.inlinePolicyClaimed`) is a name handed off, not one to
  // remove: deleting it would strip that writer's live grant. Anything the
  // predicate cannot answer deletes, as before, and so does a physical id
  // that does not name the same policy.
  if (
    standaloneInlinePolicyHandedOff(
      resourceType,
      properties,
      context?.inlinePolicyClaimed,
      physicalId
    )
  ) {
    // The logical id only: a policy or principal name can be secret-derived.
    this.logger.info(
      `  ${logicalId}: not deleting its inline policy, which another resource of this deploy now holds under the same name`
    );
    return;
  }

  // Pre-flight identity confirmation (issue #2283). Deliberately placed
  // ahead of EVERY mutating step below -- the `--remove-protection` flips,
  // the SDK delegations, and the `DeleteResource` itself -- because a
  // protection flip or an ASG force-delete against the wrong resource is
  // already damage, not merely a wasted call.
  //
  // With the PRODUCTION tables that ordering is unobservable: the only
  // guarded type is `AWS::S3::Bucket`, which has no entry in
  // `cc-protection-properties.ts` and is neither delegating type, so today
  // no mutating step actually precedes the probe for any member of the set.
  // Measured: moving this call below all three `--remove-protection` blocks
  // left the unit suite fully green UNTIL the injected case described below
  // was added, so "zero Cloud Control traffic on a refusal" fences a
  // mutation that SKIPS the guard but not one that MOVES it. That half is
  // now fenced by
  // `cloud-control-s3-delete-identity-2283.test.ts`, which injects a
  // `ccProtectionProperty` entry for the bucket type so the delete has a
  // real `UpdateResourceCommand` to issue first -- a test-side injection,
  // with no production routing changed. The SDK delegations below
  // (`AWS::AutoScaling::AutoScalingGroup`, `AWS::EC2::Instance`, and the
  // `AWS::RDS::DBCluster` / `AWS::RDS::DBInstance` pair of issue #3993) remain
  // UNFENCED, and deliberately so: fencing them would mean putting a
  // delegating type into `CC_DELETE_IDENTITY_CHECKED_TYPES`, which is a
  // routing change rather than a test.
  // Issue #2301 item 3: a guard that could NOT answer proceeds, but the
  // outcome must survive the run. A provider cannot reach the deployment-event
  // recorder, so the verdict rides out on `ResourceDeleteResult` and the
  // destroy runner persists it. Every `return` below this line therefore has
  // to carry it — see `withIndeterminateGuard`.
  const indeterminateGuard = await this.confirmDeleteTargetIdentity(
    logicalId,
    resourceType,
    physicalId,
    context
  );

  // `--remove-protection` for an `AWS::AutoScaling::AutoScalingGroup` routed
  // through Cloud Control (its template set an SDK-unwired property such as
  // `InstanceId`, so the #614 routing rule sent the whole resource
  // via Cloud Control instead of the SDK ASGProvider). Cloud Control's
  // DeleteResource cannot ForceDelete the group, clear its
  // `DeletionProtection`, or terminate the EC2-level termination-protected
  // instances the group launched — so a bare CC delete of a protected ASG
  // fails (or leaves the group + instances behind). Delegate to the SDK
  // ASGProvider, which owns the full protected force-delete sequence (group
  // `DeletionProtection` flip -> per-instance `DisableApiTermination` flip ->
  // `DeleteAutoScalingGroup(ForceDelete: true)` -> wait-gone). This keeps a
  // single source of truth for protected-ASG deletion shared across both
  // routing paths (issue #798; the SDK path is issue #796). `context` carries
  // `expectedRegion`, so the delegated provider's region check is preserved.
  if (context?.removeProtection === true && resourceType === 'AWS::AutoScaling::AutoScalingGroup') {
    this.logger.debug(
      `Delegating protected AutoScalingGroup ${logicalId} delete to the SDK ASGProvider (Cloud Control cannot force-delete a protected ASG)`
    );
    const { ASGProvider } = await import('../providers/asg-provider.js');
    // Issue #1778: PROPAGATE the delegate's verdict instead of discarding it.
    //
    // The contract for a delegating caller had two candidate shapes: assert
    // the delegate cannot skip, or pass its outcome upward. Propagation wins
    // for the same reason `NestedStackProvider.delete` propagates the child
    // runner's `skippedCount` / `interrupted` — the whole point of the
    // #1752 mechanism is that "the provider returned normally" is NOT the
    // same claim as "the resource is gone". Swallowing the delegate's
    // `'skipped'` here would make the destroy runner print
    // `✓ <id> (AWS::AutoScaling::AutoScalingGroup) deleted`, drop the state
    // record and exit 0 over an ASG the SDK provider explicitly said it
    // could not address. An assertion, by contrast, would have to be
    // re-verified every time `ASGProvider.delete` grows an arm (issue #1770
    // is adding exactly that class of arm elsewhere), and it fails LOUDLY on
    // a case the delegate considers merely unaddressable.
    //
    // Typed through the `ResourceProvider` interface deliberately: it is the
    // interface's `Promise<void | ResourceDeleteResult>` that keeps this
    // forwarding correct if `ASGProvider.delete` widens its own concrete
    // return type later, so no edit is needed here when it does.
    //
    // Looked up AFTER the import's `await`, so two concurrent deletes in one
    // region cannot each build a delegate and leave one's flips behind.
    const delegateRegion = ambientRegion();
    let asgProvider = this.asgDeleteDelegates.get(delegateRegion);
    if (asgProvider === undefined) {
      asgProvider = new ASGProvider();
      this.asgDeleteDelegates.set(delegateRegion, asgProvider);
    }
    // Issue #2301 item 3: the pre-flight ran HERE, before the delegation, so
    // its verdict is this provider's to report — the delegate never saw it
    // and cannot. Merged into whichever outcome the delegate returned rather
    // than replacing it, for the same reason the delegate's `'skipped'` is
    // propagated at all: the two facts are independent.
    //
    // UNREACHABLE with today's tables (`AWS::AutoScaling::AutoScalingGroup`
    // is not in `CC_DELETE_IDENTITY_CHECKED_TYPES`, so `indeterminateGuard`
    // is always `undefined` here) and written anyway, because the alternative
    // is a silent drop the day a delegating type joins that set.
    return withIndeterminateGuard(
      await asgProvider.delete(logicalId, physicalId, resourceType, properties, context),
      indeterminateGuard
    );
  }

  // Issue #3993: under an explicit `DeletionPolicy: Delete`, or when the user
  // opted out with `--skip-final-snapshot` (#4029), an RDS cluster or
  // instance, or a Neptune cluster (#4029), is deleted through its SDK
  // provider, never `DeleteResource`. The registry handler takes a final
  // snapshot whenever the request's `snapshotRequested` is null, and Cloud
  // Control always leaves it null, so every Cloud Control delete left an
  // untagged snapshot behind. A `Snapshot` policy, explicit or
  // CloudFormation's absent default (#4030), is refused on this route by the
  // caller, or fails closed above.
  if (
    (context?.deletionPolicy === 'Delete' || context?.skipFinalSnapshot === true) &&
    SDK_DELETE_FAMILIES.has(resourceType)
  ) {
    if (deletesThroughSdkProvider(resourceType, properties)) {
      const delegate = await this.sdkDeleteDelegateInCcRegion(resourceType, logicalId, physicalId);
      return withIndeterminateGuard(
        await delegate.delete(logicalId, physicalId, resourceType, properties, context),
        indeterminateGuard
      );
    }
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}) records a GlobalClusterIdentifier cdkd cannot detach it from, so it is deleted through ` +
        `Cloud Control, which handles the global-cluster membership. Its handler ` +
        safeMsg`can take a manual final snapshot of ${physicalId}, which cdkd does not record; ` +
        `delete it yourself if you do not want it.`
    );
  }

  // `--remove-protection` for an `AWS::EC2::Instance` routed through Cloud
  // Control (e.g. its template tripped the #614 SDK-unwired routing): Cloud
  // Control's DeleteResource has no notion of `DisableApiTermination`, so it
  // 400s "The instance ... may not be terminated. Modify its
  // 'disableApiTermination' instance attribute and try again." We flip the
  // attribute off first, then retry the delete through the modify->delete
  // propagation window (the modify WRITE lags the delete READ — see
  // ec2-termination-protection.ts). Gated on removeProtection so a protected
  // instance destroyed WITHOUT the flag still fails fast.
  const isProtectedEc2Instance =
    context?.removeProtection === true && resourceType === 'AWS::EC2::Instance';

  // `--remove-protection` for CC-routed types whose deletion protection is
  // an ordinary top-level property (issues #1312 / #1314, e.g.
  // `AWS::DSQL::Cluster.DeletionProtectionEnabled`): set it to its "off"
  // value in-place via a CC UpdateResource patch, then proceed with the
  // normal delete. Best-effort — the flip is idempotent, and if it fails
  // (throttle, IAM, unexpected schema) the delete below surfaces the real
  // error, matching the EC2 `DisableApiTermination` precedent above. Gated
  // on removeProtection so a protected resource destroyed WITHOUT the flag
  // still fails fast.
  const protectionEntry =
    context?.removeProtection === true ? ccProtectionProperty(resourceType) : undefined;

  if (!isProtectedEc2Instance && protectionEntry === undefined) {
    return this.deleteThroughCloudControl(
      logicalId,
      physicalId,
      resourceType,
      context,
      indeterminateGuard,
      undefined,
      undefined
    );
  }

  // Issue #2204: either flip runs under the compensation boundary, so a
  // delete that then fails TERMINALLY puts back the guard this run turned
  // off. Only these two arms enter it: every other Cloud Control delete
  // flips nothing and keeps the path above, untouched.
  //
  // The instance's EC2 client is pinned to the region the pre-flight vetted,
  // as a volume's is: the flip, the delete's re-flips and the compensation
  // all go through it, and the compensation's restore command names the
  // state's region.
  const ec2Client = isProtectedEc2Instance
    ? await this.ec2ClientInCcRegion(resourceType, logicalId, physicalId)
    : undefined;
  // The region the compensation's commands name: the state's, else the
  // client's own (a pre-v2 state record carries none), so a pasted command
  // never falls back to the operator's default region.
  const commandRegion = context?.expectedRegion?.trim() || (await this.ccClientRegion());
  const site =
    ec2Client !== undefined
      ? ec2InstanceProtectionSite(physicalId, commandRegion)
      : ccProtectionSite(resourceType, physicalId, protectionEntry!, commandRegion);
  let result: void | ResourceDeleteResult = undefined;
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: async (flip) => {
      let protectedEc2: ProtectedEc2Instance | undefined;
      if (ec2Client !== undefined) {
        protectedEc2 = {
          client: ec2Client,
          observedOn: await observeThenDisableInstanceApiTermination(
            ec2Client,
            physicalId,
            flip,
            this.logger
          ),
        };
      } else {
        // Read the live value first, then flip (issue #2204). The flip
        // itself stays unconditional: recorded properties can be stale vs.
        // an out-of-band console/CLI flip, and the patch is idempotent.
        await this.observeThenDisableCcProtection(
          logicalId,
          physicalId,
          resourceType,
          protectionEntry!,
          flip,
          context?.maskSecrets
        );
      }
      try {
        result = await this.deleteThroughCloudControl(
          logicalId,
          physicalId,
          resourceType,
          context,
          indeterminateGuard,
          flip,
          protectedEc2
        );
      } catch (error) {
        this.warnGuardLeftOff(flip, error, site, logicalId, physicalId);
        throw error;
      }
    },
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      site,
      reEnable: () =>
        ec2Client !== undefined
          ? reEnableInstanceApiTermination(ec2Client, physicalId)
          : this.reEnableCcProtection(logicalId, physicalId, resourceType, protectionEntry!),
    },
  });
  return result;
}

/**
 * The Cloud Control (or, for a volume, EC2) delete and its wait, after any
 * `--remove-protection` flip has run.
 *
 * `flip` is the compensation record when a flip ran (issue #2204), else
 * `undefined`. Its `deleteAccepted` is decided PER ATTEMPT, unlike the SDK
 * adopters' latch: it is cleared once each `DeleteResource` is taken (the
 * send returned a request token), and set when
 * that attempt's delete may already be running ({@link ccDeleteMayHaveActed}:
 * an abandoned wait, a FAILED with an ambiguous handler code, or a conflict
 * after an earlier attempt that may have been deleting). Any other
 * FAILED delete leaves it unset, because that is the delete refusing — the
 * case the compensation exists for — and Cloud Control accepting the REQUEST
 * says nothing about whether the handler deleted anything. Per attempt,
 * because a re-dispatched delete issues a fresh `DeleteResource`: an earlier
 * attempt's abandoned wait must not stop a later, refused one from being
 * compensated. An attempt whose `DeleteResource` send itself fails starts no
 * delete, so it keeps the earlier attempt's latch. This is also why a Cloud
 * Control-routed instance does not
 * latch at the point its SDK twin does (the accepted `TerminateInstances`):
 * that call is the handler's.
 *
 * `protectedEc2` is set for an `AWS::EC2::Instance` under
 * `--remove-protection`: it enables the propagation-race retry, whose
 * re-flips go through its region-pinned client.
 */
export async function deleteThroughCloudControl(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  indeterminateGuard: IndeterminateGuard | undefined,
  flip: ProtectionFlipRecord | undefined,
  protectedEc2: ProtectedEc2Instance | undefined
): Promise<void | ResourceDeleteResult> {
  // Issue #3455: resolved OUTSIDE the `try` below, so a region refusal can
  // never reach its already-deleted arm, which matches message substrings
  // that the interpolated logical id can contain.
  const volumeEc2Client =
    resourceType === 'AWS::EC2::Volume'
      ? await this.ec2ClientInCcRegion(resourceType, logicalId, physicalId)
      : undefined;

  const maxAttempts = protectedEc2 !== undefined ? TERMINATION_PROTECTION_MAX_ATTEMPTS : 1;
  // Whether an earlier attempt of this record may already be deleting (see
  // `ccDeleteMayHaveActed`), captured before each attempt can clear the latch.
  let priorMayBeDeleting = false;
  // go-to-k/cdkd#5975: when the first "has allocations" refusal started the
  // pool CIDR's release wait; one budget across every re-sent delete.
  let ipamReleaseWaitStartedAt: number | undefined;
  let ipamReleased = false;
  let ipamRechecks = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      // Issue #3455: an EBS volume is deleted with EC2 `DeleteVolume`, never
      // through the registry handler, which has been seen taking its own
      // snapshot and then hanging past the wait (`ec2-volume-delete.ts`).
      // The DELETE itself is inside this `try` on purpose (only AWS-authored
      // errors and the marked timeout leave it): `InvalidVolume.NotFound`
      // must reach the region-checked already-deleted arm below, as Cloud
      // Control's `NotFound` did.
      if (volumeEc2Client !== undefined) {
        await deleteEc2VolumeDirect(volumeEc2Client, physicalId, logicalId, {
          logger: this.logger,
          sleep: (ms) => this.sleep(ms),
          maxWaitMs: Math.max(
            this.MAX_WAIT_TIME_MS,
            slowCcOperationTimeoutMs(resourceType, 'DELETE')
          ),
          // The Cloud Control status poll's own grace and classifier, passed
          // in rather than re-derived so the two waits cannot drift apart.
          transientGraceMs: this.POLL_TRANSIENT_GRACE_MS,
          isTransientFailure: isTransientPollFailure,
        });
        this.logger.debug(`Deleted resource ${logicalId}`);
        return withIndeterminateGuard(undefined, indeterminateGuard);
      }

      // Issue #2204: see this method's JSDoc.
      if (flip !== undefined) priorMayBeDeleting ||= flip.deleteAccepted;
      // Start resource deletion
      const deleteResponse = await this.cloudControlClient.send(
        new DeleteResourceCommand({
          TypeName: resourceType,
          Identifier: physicalId,
        })
      );

      if (!deleteResponse.ProgressEvent?.RequestToken) {
        throw new ProvisioningError(
          `Failed to delete resource ${logicalId}: No request token received`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      // Issue #2204: a fresh delete is now running, so the latch is this
      // attempt's from here on. Cleared only HERE, once Cloud Control took
      // the request: an attempt whose send never got that far (a transport
      // outage, a throttle) must not erase that an earlier attempt may still
      // be deleting, or a later conflict with that delete would read as a
      // refusal and be compensated.
      if (flip !== undefined) flip.deleteAccepted = false;

      this.logger.debug(
        `Delete request submitted for ${logicalId}, token: ${deleteResponse.ProgressEvent.RequestToken}`
      );

      // Wait for deletion to complete
      await this.waitForOperation(
        deleteResponse.ProgressEvent.RequestToken,
        logicalId,
        'DELETE',
        resourceType
      );

      this.logger.debug(`Deleted resource ${logicalId}`);
      return withIndeterminateGuard(undefined, indeterminateGuard);
    } catch (error) {
      // Issue #2204: a delete that may already be running must not have its
      // guard put back. See this method's JSDoc.
      if (
        flip !== undefined &&
        ccDeleteMayHaveActed(error, protectedEc2 !== undefined, priorMayBeDeleting)
      ) {
        flip.deleteAccepted = true;
      }
      // Treat a typed not-found as idempotent success for DELETE, but only
      // when the AWS client is operating against the same region the
      // resource was deployed to. A region mismatch must surface — otherwise a
      // destroy run with the wrong region would silently strip every resource
      // from state while leaving the actual AWS resources orphaned.
      //
      // TYPED signals only (issue #5225, `isCcDeleteGoneError`): the
      // handler's `ErrorCode: NotFound` (issue #1252), `DeleteResource`'s
      // `ResourceNotFoundException`, and the volume path's
      // `InvalidVolume.NotFound`. Message needles read a missing DEPENDENCY,
      // a `TypeNotFoundException` or a logical id such as `PageNotFound` as
      // gone. An ABANDONED wait (issue #3236) is refused through the SHARED
      // predicate, one of FOUR classifiers that must refuse it.
      const err = error as { name?: string; message?: string };
      if (isCcDeleteGoneError(error, volumeEc2Client !== undefined)) {
        // Through the SAME helper as the pre-flight above (issue #2301
        // review), not a second hand-rolled comparison. Two comparisons of
        // the same two values in one method, normalised differently, is a
        // disagreement waiting to be reached -- and it WAS reachable: this
        // arm compared raw, so a client region of `US-EAST-1` (which
        // `foldRegionOption` does not fold, because it only folds `--region`
        // / `AWS_REGION` / `AWS_DEFAULT_REGION` and not a profile's
        // `region = US-EAST-1`) passed the pre-flight and was then REFUSED
        // here against a state region of `us-east-1`. Sharing the helper
        // also means this refusal is marked non-retryable and gets the same
        // typed-refusal protection from the "already deleted" message
        // classifiers as the pre-flight one.
        await this.assertRecordedRegionAgainstClient(
          'not-found',
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Resource ${logicalId} already deleted (not found), treating as success`);
        // Still carries the guard: an unanswerable identity probe followed by
        // a `NotFound` delete is exactly the sequence a DENIED probe produces
        // when the name really does denote something elsewhere, so this is
        // the LAST place to drop the record.
        return withIndeterminateGuard(undefined, indeterminateGuard);
      }
      if (
        protectedEc2 !== undefined &&
        isTerminationProtectionPropagationError(err.message ?? '') &&
        attempt < maxAttempts
      ) {
        this.logger.debug(
          `Cloud Control delete of ${logicalId} raced the DisableApiTermination flip-off (attempt ${attempt}/${maxAttempts}); re-flipping and retrying`
        );
        await reDisableInstanceApiTermination(
          protectedEc2.client,
          physicalId,
          flip!,
          protectedEc2.observedOn,
          this.logger
        );
        await this.sleep(3000 * attempt);
        continue;
      }
      // go-to-k/cdkd#5975: the pool refuses to deprovision this CIDR while a
      // VPC or subnet it allocated to is deleted but not yet RELEASED, which
      // AWS can take past the VPC's own 25-minute wait. Wait for those
      // allocations here and send the same delete again, as Terraform's pool
      // CIDR delete waits for them first. Any other holder fails now.
      if (resourceType === 'AWS::EC2::IPAMPoolCidr' && isCidrHasAllocationsRefusal(error)) {
        ipamReleaseWaitStartedAt ??= Date.now();
        const verdict = await awaitIpamPoolCidrRelease.call(
          this,
          logicalId,
          physicalId,
          resourceType,
          ipamPoolCidrReleaseBudgetMs(resourceType) - (Date.now() - ipamReleaseWaitStartedAt),
          ipamReleased,
          ipamRechecks < MAX_IPAM_RECHECKS
        );
        if (verdict === 'released') {
          ipamReleased = true;
          ipamRechecks = 0;
          continue;
        }
        if (verdict === 'recheck') {
          ipamRechecks++;
          continue;
        }
      }
      // Issue #5225: what this arm kept must not be dropped one level up by
      // the engine's or the destroy runner's substring classifiers.
      try {
        this.handleError(error, 'DELETE', resourceType, logicalId, physicalId);
      } catch (wrapped) {
        throw markNotGoneOnNeedle(wrapped);
      }
    }
  }
}

/**
 * go-to-k/cdkd#5975: the handler's own refusal of a pool CIDR delete while
 * the CIDR has allocations. Read off the FAILED operation only: the message
 * also carries the logical id, which cannot spell this sentence.
 */
function isCidrHasAllocationsRefusal(error: unknown): boolean {
  return (
    error instanceof CloudControlOperationFailedError &&
    error.ccOperation === 'DELETE' &&
    error.message.includes(IPAM_CIDR_HAS_ALLOCATIONS)
  );
}

/**
 * go-to-k/cdkd#5975: the release wait {@link waitForLingeringIpamAllocations}
 * describes, for a refused `AWS::EC2::IPAMPoolCidr` delete. Anything that
 * keeps it from reading (an identifier of another shape, a region mismatch, an
 * unknown account, a spent budget) answers `'none'`, so the caller fails with
 * the handler's refusal, as before.
 */
async function awaitIpamPoolCidrRelease(
  this: CloudControlProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  budgetMs: number,
  afterRelease: boolean,
  allowRecheck: boolean
): Promise<IpamReleaseVerdict> {
  const poolId = ipamPoolIdOfPoolCidr(physicalId);
  if (poolId === undefined || budgetMs <= 0) return 'none';
  let ec2: EC2Client;
  let accountId: string;
  let region: string;
  try {
    ec2 = await this.ec2ClientInCcRegion(resourceType, logicalId, physicalId);
    region = canonicalizeRegion((await ec2.config.region()).trim());
    accountId = (await getAccountInfo(region)).accountId;
  } catch (error) {
    this.logger.debug(
      safeMsg`${logicalId}: cannot read IPAM pool ${poolId}'s allocations, so the pool CIDR delete is not retried: ${describeAwsFailure(error).detail}`
    );
    return 'none';
  }
  return waitForLingeringIpamAllocations({
    ec2,
    poolId,
    accountId,
    region,
    resourceType,
    logger: this.logger,
    maxWaitMs: budgetMs,
    afterRelease,
    allowRecheck,
    sleep: (ms) => this.sleep(ms),
  });
}

/**
 * The SDK delete delegate for this type's family (issues #3993, #4029), its
 * client pinned to THIS provider's Cloud Control client region: the region the recorded-region
 * pre-flight vetted. An ambient-region client can differ from it (a command
 * that swaps the AWS clients without the environment), and RDS identifiers
 * are names, so a delete there could remove a same-named resource in
 * another region and then read its absence as success. An unresolvable
 * region is refused, as `ec2ClientInCcRegion` does for a volume.
 */
export async function sdkDeleteDelegateInCcRegion(
  this: CloudControlProvider,
  resourceType: string,
  logicalId: string,
  physicalId: string
): Promise<ResourceProvider> {
  let ccRegion: string | undefined;
  try {
    ccRegion = canonicalizeRegion((await this.cloudControlClient.config.region())?.trim());
  } catch {
    ccRegion = undefined;
  }
  if (ccRegion === undefined || ccRegion === '') {
    throw markNonRetryable(
      new ProvisioningError(
        `Refusing to delete ${logicalId} (${resourceType}, ${physicalId}): cdkd could not ` +
          `resolve the Cloud Control client's region, so it cannot show the SDK delete ` +
          `would reach this resource. Re-run with --region set to the stack's region.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  const family = SDK_DELETE_FAMILIES.get(resourceType)!;
  const cached = this.sdkDeleteDelegates.get(family);
  if (cached !== undefined && cached.region === ccRegion) return cached.provider;
  const provider: ResourceProvider =
    family === 'rds'
      ? new (await import('../providers/rds-provider.js')).RDSProvider({ region: ccRegion })
      : new (await import('../providers/neptune-provider.js')).NeptuneProvider({
          region: ccRegion,
        });
  this.sdkDeleteDelegates.set(family, { region: ccRegion, provider });
  return provider;
}

/**
 * The EC2 client for a delete this provider issues through EC2 instead of
 * Cloud Control (issue #3455), and for a protected instance's
 * `DisableApiTermination` flip and its compensation (issue #2204), refused
 * unless it targets the SAME region as the Cloud Control client the region
 * pre-flight vetted.
 *
 * `getAwsClients()` is read at call time while `cloudControlClient` was
 * captured at construction, so the two are not the same object and could
 * name different regions. The comparison is load-bearing rather than
 * defensive: a volume id is region-scoped, so a wrong-region `DeleteVolume`
 * answers `InvalidVolume.NotFound`, which the caller's already-deleted arm
 * would take as success and drop the record of a live volume.
 */
export async function ec2ClientInCcRegion(
  this: CloudControlProvider,
  resourceType: string,
  logicalId: string,
  physicalId: string
): Promise<EC2Client> {
  const ec2 = getAwsClients().ec2;
  const resolve = async (client: { config: { region: () => Promise<string> } }) => {
    try {
      return canonicalizeRegion((await client.config.region())?.trim());
    } catch {
      return undefined;
    }
  };
  const ccRegion = await resolve(this.cloudControlClient);
  const ec2Region = await resolve(ec2);
  if (ccRegion === undefined || ccRegion === '' || ccRegion !== ec2Region) {
    throw markNonRetryable(
      new ProvisioningError(
        `Refusing to delete ${logicalId} (${resourceType}, ${physicalId}): the EC2 client ` +
          `targets region '${ec2Region ?? 'unknown'}' but the Cloud Control client targets ` +
          `'${ccRegion ?? 'unknown'}', so cdkd cannot show ` +
          (resourceType === 'AWS::EC2::Instance'
            ? `its DisableApiTermination flip would reach this instance. `
            : `the delete would reach this volume. `) +
          `Re-run with --region set to the stack's region.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  return ec2;
}
