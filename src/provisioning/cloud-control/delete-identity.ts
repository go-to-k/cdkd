import type { CloudControlProvider } from '../cloud-control-provider.js';
import { GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { displaySafe } from '../../utils/display-safe.js';
import { assertRegionMatch, type DeleteContext, type RegionCheckPhase } from '../region-check.js';
import type { IndeterminateGuard } from '../../types/resource.js';
import {
  requiresCcDeleteIdentityCheck,
  CC_DELETE_REGION_IDENTITY_GUARD,
  bucketLocationToRegion,
  isNoSuchBucketError,
} from './delete-guards.js';

/**
 * Refuse a Cloud Control call whose target region cannot be shown to be the
 * one the state record was written in (issue #2301).
 *
 * The ONE place this comparison happens, for all three phases: the
 * pre-flights at the top of `delete()` and `update()`, and the reactive
 * `not-found` arm inside `delete()`'s catch block. They can therefore never
 * disagree about what "unknown region" means, nor about how a region is
 * SPELLED -- the second one was live before this became shared: the reactive
 * arm compared raw while the pre-flight folded case, so one correct call
 * could pass the first and be refused by the second. THREE inputs, THREE outcomes, and they are
 * deliberately not two:
 *
 *  - NO recorded region (`undefined`, or an empty / whitespace-only string)
 *    -> PROCEED, and do not even resolve the client region. This is the
 *    guard's OWN default: a `version: 1` state record predates the
 *    region-scoped key layout and carries no region at all, and callers
 *    typed `region: string` (`deploy-engine.ts`'s `stackRegion`) can hand
 *    over `''`. Refusing on the absence would break every ordinary
 *    destroy / update of a pre-v2 record, which is the over-tightening
 *    failure a one-directional fence never sees.
 *  - A recorded region that MATCHES the client -> proceed silently. This is
 *    the ordinary path and it must stay free of new refusals: the whole
 *    fleet of same-region deletes and updates runs through here.
 *  - A recorded region that DIFFERS, or a client region that cannot be
 *    resolved at all -> REFUSE before issuing anything.
 *
 * The unresolvable-client-region arm is the one asymmetry worth naming:
 * {@link CloudControlProvider.confirmDeleteTargetIdentity} PROCEEDS when it
 * cannot establish a region, and this helper refuses. The two are answering
 * different questions. That probe asks a remote service where a globally
 * unique NAME lives, and a least-privilege role that was never granted
 * `s3:GetBucketLocation` would be stranded by a refusal. Here the caller has
 * positively recorded a region, the comparison is local and free, and a
 * client that cannot say where it points cannot be shown to point at that
 * region -- the same answer `assertRegionMatch` has always given on its
 * `not-found` phase.
 *
 * The refusal is marked non-retryable because it is deterministic: both
 * loops that wrap these calls -- the destroy runner's own attempt loop and
 * the deploy engine's / rollback executor's `withRetry` -- would otherwise
 * spend their full budget re-deriving the same verdict, which reads to a
 * user as flaky AWS rather than as a refusal.
 */
export async function assertRecordedRegionAgainstClient(
  this: CloudControlProvider,
  phase: RegionCheckPhase,
  expectedRegion: string | undefined,
  resourceType: string,
  logicalId: string,
  physicalId: string
): Promise<void> {
  // Trimmed AND case-folded, matching `confirmDeleteTargetIdentity` below.
  // Both halves are load-bearing and both were MEASURED against this suite:
  // a `--region US-EAST-1` destroy and a padded state region are correct
  // inputs, and comparing them raw (which is what the `not-found` phase has
  // always done, on a branch narrow enough that it never showed) would
  // refuse them. A guard that rejects its own callers' ordinary spellings is
  // the over-tightening half of this change, not a stricter version of it.
  const recordedRegion = canonicalizeRegion(expectedRegion?.trim());
  if (recordedRegion === undefined || recordedRegion === '') return;

  let clientRegion: string | undefined;
  try {
    clientRegion = canonicalizeRegion((await this.cloudControlClient.config.region())?.trim());
  } catch (error) {
    // Resolution FAILED, which is not the same as "resolved to something
    // else" -- leave it undefined so `assertRegionMatch` produces the
    // "client region is unknown" refusal rather than letting a raw SDK
    // credential-chain error surface from a guard.
    this.logger.debug(
      `Could not resolve the Cloud Control client region before the ${phase} region check ` +
        `for ${logicalId} (${resourceType}): ` +
        // `.detail` is right on a `debug` line, and it is the guarded
        // stringification: a bare `String(value)` throws on a
        // null-prototype object, and this catch exists so the region check
        // can produce its own refusal rather than letting a raw SDK error
        // surface.
        // `displaySafe` for consistency with the other two detail lines on
        // this path: `debug` is lower-exposure than the persisted message,
        // not exposure-free, and this text comes from the SDK.
        `${displaySafe(describeAwsFailure(error).detail)}`
    );
    clientRegion = undefined;
  }

  try {
    assertRegionMatch(clientRegion, recordedRegion, resourceType, logicalId, physicalId, phase);
  } catch (error) {
    throw markNonRetryable(error as Error);
  }
}

/**
 * Confirm that the resource `physicalId` names actually lives in the region
 * this destroy is targeting, for the types in
 * {@link CC_DELETE_IDENTITY_CHECKED_TYPES}. No-op for every other type.
 *
 * WHAT THIS GUARDS THAT `assertRegionMatch` DOES NOT
 * ---------------------------------------------------
 * The `assertRegionMatch` comparison — which since issue #2301 runs both as
 * an unconditional pre-flight and on the `NotFound` arm below — compares the
 * CLIENT's region against the STATE's. That misses this hazard however often
 * it runs: both of its inputs can agree while the bucket the physical id
 * names sits somewhere else entirely. An `AWS::S3::Bucket` physical id is
 * a GLOBALLY unique name, so a state record written before the issue #2227 /
 * #2245 guards existed can name a bucket that is ours but lives elsewhere --
 * a cdkd-GENERATED bucket name carries no region or account: for a name cdkd
 * derives itself, `resource-name.ts:240` builds
 * `` `${currentStackName}-${name}` `` whenever `resource-name.ts:239`'s
 * `shouldPrefix` holds, so the same stack deployed to two regions produces
 * the same bucket name by construction. (That guard has a second, unrelated
 * path -- it also drops the prefix when there is no ambient stack name at
 * all -- so it is quoted here rather than enumerated.) And a delete of such a bucket is NOT expected to come back
 * `NotFound`: the mechanism issues #2245 / #2283 record is that S3 follows
 * the region redirect for a body-bearing operation, so the delete lands on
 * the live bucket in the other region and this catch block is never entered.
 * Nothing downstream can undo that, which is why the confirmation is
 * pre-flight rather than a wider net around the existing handler. The live
 * arm in `tests/integration/s3-lifecycle` (phase 0c) is what holds that
 * mechanism to account on THIS route.
 *
 * THE PROBE HAS THREE OUTCOMES AND ALL THREE ARE DISTINCT
 * -------------------------------------------------------
 *  - ANSWERED, region matches -> proceed silently. The hot path costs one
 *    `GetBucketLocation`.
 *  - ANSWERED, region differs -> REFUSE, non-retryable. Both retry loops
 *    that wrap a `delete()` honour the marker and would otherwise re-run the
 *    whole delete for their full budget before surfacing the same
 *    deterministic message, which reads as flaky AWS: the destroy path's own
 *    loop (`destroy-runner.ts:1328`, which runs FOUR attempts -- `attempt`
 *    goes 0..`maxAttempts` and `maxAttempts` is 3 at `:1326` -- with
 *    `isMarkedNonRetryable` gating both of its retryable arms at `:1372`)
 *    and the deploy engine's `withRetry` (`retry.ts:332`) on the
 *    replacement-delete path.
 *  - COULD NOT ANSWER -> proceed, but WARN at default verbosity. Refusing
 *    would strand destroys for least-privilege roles that never granted
 *    `s3:GetBucketLocation`, with no escape hatch. But proceeding SILENTLY
 *    is what the issue #2245 review rejected: a bucket policy denying
 *    `s3:GetBucketLocation` -- settable by anyone holding
 *    `s3:PutBucketPolicy` on the target -- would disable this guard while
 *    the operator's output stayed identical to a normal destroy. Failing
 *    closed on 403 alone is not the answer either, because a missing IAM
 *    grant and a hostile `Deny` are the same wire response.
 *
 * A bucket that is ABSENT is a fourth thing and is NOT the warning case: the
 * name denotes nothing, so there is nothing to delete in the wrong region,
 * and the `DeleteResource` below reaches its existing `NotFound` /
 * `assertRegionMatch` handling. Warning there would fire on every ordinary
 * re-run of an already-completed destroy.
 *
 * `GetBucketLocation` and not `HeadBucket`: a cross-region `HeadBucket` 301s
 * and SDK v3's region-redirect middleware mishandles the empty-body HEAD
 * response, yielding a synthetic `name: 'Unknown'`. That would land every
 * foreign-region bucket -- the exact case this exists to catch -- in the
 * indeterminate arm, which PROCEEDS. `src/utils/aws-region-resolver.ts`
 * records the same finding, and the SDK-side guard re-learned it the
 * expensive way.
 *
 * RETURN VALUE (issue #2301 item 3). `undefined` means the guard reached a
 * verdict — it confirmed the region, or the type is unguarded, or the bucket
 * is absent (a fourth outcome, not an indeterminate one, per the paragraph
 * above). An {@link IndeterminateGuard} means it could NOT, and the caller
 * must carry it out through `ResourceDeleteResult` so the destroy runner can
 * persist a `RESOURCE_GUARD_INDETERMINATE` event. A MISMATCH still throws.
 *
 * The two indeterminate arms below produce THREE distinct `reason` texts,
 * not two, and that is deliberate: the region-resolution arm falls THROUGH
 * into the no-region warn, so before this change a client whose SDK region
 * chain REJECTED was reported identically to one that was never asked. The
 * remedies differ (fix the credential chain / pass `--region` vs. repair the
 * state record), so the durable record — and the warn beside it — names
 * which happened.
 */
export async function confirmDeleteTargetIdentity(
  this: CloudControlProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  context?: DeleteContext
): Promise<IndeterminateGuard | undefined> {
  if (!requiresCcDeleteIdentityCheck(resourceType)) return undefined;

  // `expectedRegion` is the state's recorded region and is the right
  // comparand when it is there. The client region is the fallback rather
  // than a skip: it is where `DeleteResource` will actually run, so a
  // mismatch against it is the same wrong-target delete.
  //
  // Its population, MEASURED rather than assumed (an earlier revision of
  // this comment claimed the "type-only `getProvider` call sites (destroy /
  // drift / state-refresh)", which is wrong on both halves: destroy, drift
  // and state-refresh all use `getProviderFor` WITH `provisionedBy`
  // -- `destroy-runner.ts:1284`, `drift.ts:2122` / `:3930`,
  // `state.ts:2340` / `:2394` -- and drift / state-refresh never call
  // `delete()` at all; the real `getProvider(` sites are `import.ts`,
  // `deploy-engine.ts` and `canonicalize-properties.ts`):
  //
  //  - `destroy-runner.ts:1336` spreads `expectedRegion` only when
  //    `state.region !== undefined`, so a PRE-v2 state record (where
  //    `region` was not yet part of the key layout) arrives with no region.
  //  - any caller threading an EMPTY region string. `deploy-engine.ts`
  //    types its `stackRegion` as `string`, so `''` reaches here as a
  //    DEFINED value.
  //
  // That second case is why this is not a bare `??`: `''` is not `null` or
  // `undefined`, so `??` would accept it, skip the client fallback, and
  // land in the warn below whose text ("neither ... reports a region")
  // would then be false, because the client was never asked.
  const recordedRegion = context?.expectedRegion?.trim();
  let expectedRegion: string | undefined =
    recordedRegion === undefined || recordedRegion === '' ? undefined : recordedRegion;
  // Set only when the SDK region chain REJECTED, which is a different fact
  // from "resolved to nothing" and gets a different `reason` / warn tail.
  let clientRegionError: string | undefined;
  if (expectedRegion === undefined) {
    try {
      const clientRegion = (await this.cloudControlClient.config.region())?.trim();
      expectedRegion = clientRegion === undefined || clientRegion === '' ? undefined : clientRegion;
    } catch (error) {
      // Same policy as a probe that cannot answer: report and PROCEED. An
      // unresolvable SDK region chain must not abort a delete that would
      // otherwise have run -- that would make this guard fail closed on one
      // input while failing open on every other undeterminable one. The
      // warn immediately below is the visible outcome.
      // Issue #2302's split, applied BEFORE the value can reach a durable
      // record. `summary` is the half safe to persist; `detail` is AWS's own
      // wording and goes to `debug` only. A cdkd- or SDK-authored failure
      // passes through unreduced, which is the point of the narrow rule.
      const clientRegionFailure = describeAwsFailure(error);
      clientRegionError = clientRegionFailure.summary;
      this.logger.debug(
        `Could not resolve the Cloud Control client region while confirming ${physicalId}: ` +
          `${clientRegionFailure.detail}`
      );
      expectedRegion = undefined;
    }
  }
  if (expectedRegion === undefined) {
    // The two spellings share the head so the pre-existing needle still
    // matches, and diverge on the tail so the fixed text is not a lie about
    // which of the two happened. `reason` mirrors the tail rather than
    // paraphrasing it: a durable record that disagrees with the terminal is
    // worse than either alone.
    const reason =
      clientRegionError === undefined
        ? `neither the stack state nor the AWS client reports a region`
        : `the stack state records no region and the AWS client's region could not be ` +
          `resolved: ${clientRegionError}`;
    // The persisted `reason` above keeps its cause VERBATIM -- it ends the
    // string, so its own trailing period is correct -- while the warn strips
    // it, because the warn appends another sentence. Exactly the split the
    // probe arm below uses, and the reason this arm needs it too:
    // `clientRegionError` is a `describeAwsFailure` summary, so its REDACTED
    // shape already ends in the helper's own sentence and would render
    // `own message.. Proceeding with the delete.` The sibling commit fixed
    // only the arm the live run happened to exercise.
    this.logger.warn(
      `Could not confirm that ${resourceType} ${physicalId} (${logicalId}) is the resource ` +
        `this destroy targets: ${reason.replace(/[.\s]+$/, '')}. Proceeding with the delete.`
    );
    return { guard: CC_DELETE_REGION_IDENTITY_GUARD, reason };
  }
  const wantRegion = canonicalizeRegion(expectedRegion);

  let actualRegion: string;
  try {
    // Deliberately NO `ExpectedBucketOwner`, unlike `state.ts:1738` and
    // `utils/aws-region-resolver.ts`, which both pass it. Those two are
    // asking "is this MY bucket, and where is it", and a foreign-owned
    // bucket 403ing is the answer they want. This probe asks the opposite
    // question: the whole hazard is a name that resolves to a bucket cdkd
    // must NOT delete, and the guard has to hear the foreign answer to
    // refuse. Adding the parameter back to match the convention would turn
    // every cross-account collision from a REFUSAL into a 403 -> the
    // indeterminate arm -> warn-and-proceed. Leaking the region of a bucket
    // whose NAME is already in this account's state file is not a
    // disclosure; deleting it is the harm.
    const location = await getAwsClients().s3.send(
      new GetBucketLocationCommand({ Bucket: physicalId })
    );
    actualRegion = bucketLocationToRegion(location.LocationConstraint);
  } catch (error) {
    if (isNoSuchBucketError(error)) {
      this.logger.debug(
        `Bucket ${physicalId} (${logicalId}) is already absent; leaving the delete to the ` +
          `Cloud Control idempotency path`
      );
      return undefined;
    }
    // NEVER AWS's own message here, in either half (issue
    // [#2302](https://github.com/go-to-k/cdkd/issues/2302)). The headline
    // population for this arm is a bucket policy DENYING
    // `s3:GetBucketLocation`, and S3 words that `AccessDenied` as `User:
    // arn:aws:sts::<account>:assumed-role/<role>/<session> is not authorized
    // to perform: ...` -- so interpolating it writes the destroying
    // principal's account id, role name and session name to the terminal AND,
    // since issue #2301 item 3, into `deployments/{runId}.jsonl`, which
    // `cdkd destroy` deliberately does not sweep. Making the guard DURABLE
    // must not make the caller durable: the attacker sets the policy, so they
    // choose when that record is written. The SDK-routed twin of this guard
    // reached the same answer at `s3-bucket/create-identity.ts`'s `probeFailedCause`.
    // Both halves are emitted, per that helper's contract -- the class in the
    // persisted `reason`, AWS's wording at `debug`, because the wording is
    // what separates a missing IAM grant from a bucket-policy `Deny` and that
    // distinction is the operator's next action.
    const failure = describeAwsFailure(error);
    this.logger.debug(
      `s3:GetBucketLocation on ${physicalId} (${logicalId}) failed: ${failure.detail}`
    );
    // Trailing sentence punctuation is stripped before this clause re-adds
    // it, because the two `summary` shapes disagree about it: a REDACTED one
    // ends in the helper's `VERBOSE_POINTER` sentence and already carries a
    // period, while a passed-through cdkd- or SDK-authored message usually
    // does not. Interpolating either directly is wrong for the other -- the
    // live run of `s3-lifecycle` phase 0c-ID printed `for AWS's own
    // message.. S3 bucket names ...` to a user-facing security warning.
    const summarySentence = failure.summary.replace(/[.\s]+$/, '');
    this.logger.warn(
      `Could not confirm which region S3 bucket ${physicalId} (${logicalId}) lives in before ` +
        `deleting it: ${summarySentence}. S3 bucket names are globally unique, so cdkd cannot ` +
        `rule out that this name denotes a bucket in another region. Grant s3:GetBucketLocation ` +
        `on the bucket to enable the check. Proceeding with the delete.`
    );
    return {
      guard: CC_DELETE_REGION_IDENTITY_GUARD,
      reason: `s3:GetBucketLocation on ${physicalId} could not be answered: ${failure.summary}`,
    };
  }

  if (actualRegion === wantRegion) {
    this.logger.debug(
      `Confirmed S3 bucket ${physicalId} (${logicalId}) lives in ${wantRegion} before deleting it`
    );
    return undefined;
  }

  throw markNonRetryable(
    new ProvisioningError(
      `Refusing to delete S3 bucket ${physicalId} for ${logicalId} (${resourceType}): the ` +
        `bucket carrying that name lives in ${actualRegion}, while this destroy targets ` +
        `${wantRegion}. S3 bucket names are globally unique, so a physical id recorded in ` +
        `cdkd state can denote a bucket in a different region. S3 follows the region ` +
        `redirect for a body-bearing operation, so issuing this delete risks destroying the ` +
        `live bucket in ${actualRegion} instead, unrecoverably, rather than reporting the ` +
        `bucket absent. Confirm the physical id recorded in cdkd state ` +
        `(cdkd state show) and correct the record: --region does not change this comparison, ` +
        `which reads the region stored in the state file, so re-running the destroy with a ` +
        `different flag value will not resolve it.`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}
