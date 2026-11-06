import type { EFSProvider } from '../efs-provider.js';
import {
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  DescribeAccessPointsCommand,
  type DescribeAccessPointsCommandOutput,
  AccessPointNotFound,
  AccessPointAlreadyExists,
  type AccessPointDescription,
  type CreateAccessPointCommandInput,
  type PosixUser,
  type RootDirectory,
} from '@aws-sdk/client-efs';
import { isDeepStrictEqual } from 'node:util';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import { acquireIdempotencyToken } from '../idempotency-token.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { withRetry } from '../../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../types/resource.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { withPasteableAwsProfile } from '../../../utils/pasteable-aws-profile.js';

/**
 * Whether an access point's `PosixUser` is the one a `CreateAccessPoint`
 * request asked for (issue #3894), used to confirm an adoption.
 *
 * EFS puts an unset POSIX user on the wire as `null` (measured through the
 * AWS CLI, issue #2442), and the SDK deserializer drops that null member, so
 * the description reaches here without the key. An absent request therefore
 * matches a described user that is absent OR null. `SecondaryGids` is a set,
 * so an omitted list equals an empty one and order is ignored.
 */
function samePosixUser(
  requested: PosixUser | undefined,
  described: PosixUser | null | undefined
): boolean {
  if (requested == null || described == null) return requested == null && described == null;
  const gids = (user: PosixUser): string =>
    JSON.stringify([...new Set(user.SecondaryGids ?? [])].sort((a, b) => a - b));
  return (
    requested.Uid === described.Uid &&
    requested.Gid === described.Gid &&
    gids(requested) === gids(described)
  );
}

/**
 * Whether an access point's `RootDirectory` is the one a `CreateAccessPoint`
 * request asked for (issue #3894), used to confirm an adoption.
 *
 * EFS reads an omitted `RootDirectory` back as `{ Path: "/" }` (measured,
 * issue #2442), so both sides are read through that default before
 * comparing; comparing raw would decline every adoption of a default-root
 * access point. A root with `CreationInfo` but no `Path` is ASSUMED to default
 * the same way -- unmeasured, and the `?? '/'` on both sides matches whether
 * EFS answers `/` or omits the member. `Permissions` is an octal string (`^[0-7]{3,4}$`), so `755`
 * and `0755` are the same mode.
 */
function sameRootDirectory(
  requested: RootDirectory | undefined,
  described: RootDirectory | null | undefined
): boolean {
  if ((requested?.Path ?? '/') !== (described?.Path ?? '/')) return false;
  const want = requested?.CreationInfo ?? undefined;
  const have = described?.CreationInfo ?? undefined;
  if (want === undefined || have === undefined) return want === undefined && have === undefined;
  const mode = (p: string | undefined): number | string | undefined =>
    p !== undefined && /^[0-7]+$/.test(p) ? parseInt(p, 8) : p;
  return (
    want.OwnerUid === have.OwnerUid &&
    want.OwnerGid === have.OwnerGid &&
    mode(want.Permissions) === mode(have.Permissions)
  );
}

export async function updateAccessPoint(
  this: EFSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  // Every property but AccessPointTags is create-only in the CFn schema, so
  // the replacement-detection layer routes such a change through
  // DELETE+CREATE; reaching here with one, refuse rather than apply the
  // tags alone and report success. Key-order-insensitive, like the engine's
  // own diff (a synth-fresh object vs a JSON.parse'd record). A recorded
  // LEAF holding a dynamic reference or cdkd's mask never equals its
  // resolved desired value, so that leaf alone is left to the diff layer,
  // which decided; its siblings are still compared.
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const sameExceptSecretLeaves = (desired: unknown, recorded: unknown): boolean => {
    // A removed secret-derived leaf (desired undefined) is still a change.
    if (
      desired !== undefined &&
      typeof recorded === 'string' &&
      holdsSecretDerivedEntry(recorded)
    ) {
      return true;
    }
    if (Array.isArray(desired) && Array.isArray(recorded)) {
      return (
        desired.length === recorded.length &&
        desired.every((d, i) => sameExceptSecretLeaves(d, recorded[i]))
      );
    }
    if (isPlainObject(desired) && isPlainObject(recorded)) {
      const ks = new Set([...Object.keys(desired), ...Object.keys(recorded)]);
      return [...ks].every((k) => sameExceptSecretLeaves(desired[k], recorded[k]));
    }
    return isDeepStrictEqual(desired, recorded);
  };
  const keys = new Set([...Object.keys(properties), ...Object.keys(previousProperties)]);
  for (const key of keys) {
    if (key === 'AccessPointTags') continue;
    if (!sameExceptSecretLeaves(properties[key], previousProperties[key])) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `AWS EFS AccessPoint ${key} changed or was removed, and it is immutable on AWS — there is no UpdateAccessPoint command, and only AccessPointTags can change in place; any other property change requires DeleteAccessPoint + CreateAccessPoint. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.`
      );
    }
  }

  refuseMalformedDesiredTags(
    properties['AccessPointTags'],
    resourceType,
    logicalId,
    physicalId,
    'AccessPointTags'
  );

  try {
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['AccessPointTags'],
      properties['AccessPointTags'],
      log
    );
    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update EFS AccessPoint ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

// ─── AWS::EFS::AccessPoint ─────────────────────────────────────────

export async function createAccessPoint(
  this: EFSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating EFS AccessPoint ${logicalId}`);

  const fileSystemId = properties['FileSystemId'] as string | undefined;
  if (!fileSystemId) {
    throw new ProvisioningError(
      `FileSystemId is required for EFS AccessPoint ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const posixUser = properties['PosixUser'] as
    | { Uid: number; Gid: number; SecondaryGids?: number[] }
    | undefined;

  const rootDirectory = properties['RootDirectory'] as
    | {
        Path?: string;
        CreationInfo?: {
          OwnerUid: number;
          OwnerGid: number;
          Permissions: string;
        };
      }
    | undefined;

  const tags = properties['AccessPointTags'] as Array<{ Key: string; Value: string }> | undefined;

  // Issue #2039's mechanism applied to `CreateAccessPoint`; issue
  // [#2080](https://github.com/go-to-k/cdkd/issues/2080) names its absence.
  // The deploy engine wraps every `create()` in an outer transient-error
  // retry and issue #2026 made a bare HTTP 5xx one of them, so a request that
  // actually SUCCEEDED server-side before its response was lost re-enters
  // here from the top. Without a stable token the replay mints a SECOND
  // access point that no state record names, so `cdkd destroy` never reaches
  // it.
  //
  // The field was never simply ABSENT from the wire. EFS models `ClientToken`
  // with Smithy's `idempotencyToken` trait, so the SDK auto-fills it when the
  // caller omits it -- with a fresh value PER REQUEST. Measured against
  // `@aws-sdk/client-efs` 3.1018.0 by capturing two identical sends:
  // `846a541f-ada4-44c5-9d13-f7f32596a5f0` then
  // `d84cafec-c6bb-4be3-b333-696796347e33`. That is the shape issue #2080
  // calls worse than no token at all -- the call site reads as idempotent and
  // behaves exactly as if it were not -- and the same probe shows a
  // caller-supplied value reaching the wire verbatim, which is why the
  // `unhandledByDesign` rationale above no longer says the SDK owns this.
  //
  // DERIVATION. `acquireIdempotencyToken` (per-process nonce, memoised for
  // the life of one create, retired on success), NOT the deterministic
  // sha256-of-immutable-inputs this same file uses for a file system's
  // `CreationToken`.
  //
  // Deliberately NOT argued from a retirement window. EFS publishes no
  // retirement period for a `CreateAccessPoint` `ClientToken`: the only such
  // statement in the EFS User Guide ("Creation token and idempotency", one
  // minute) sits in a section whose examples are file-system CREATION
  // tokens, and the `CreateAccessPoint` API reference describes the repeat
  // unconditionally, as `AccessPointAlreadyExists` with no window attached.
  // Treat the duration as unknown; the choice does not need it, because the
  // process-scoped derivation is right under BOTH readings:
  //
  //  - If the token IS retired quickly, a value stable across runs buys
  //    nothing -- no two `cdkd deploy` invocations are that close together on
  //    one create -- while it would put a `--replace` delete-then-create
  //    inside the replay window of the access point it had just deleted,
  //    which is the hazard `IdempotencyToken.release` exists to prevent.
  //  - If it instead binds for the access point's LIFETIME (what the API
  //    reference reads like, and what makes the file system's `CreationToken`
  //    hash correct for THAT call), a deterministic hash is worse still: any
  //    re-create whose immutable inputs are unchanged -- a forced
  //    `--replace`, or a redeploy after a lost state record -- would collide
  //    with the live access point instead of creating one.
  //
  // Either way the helper's guarantee is the one this fix needs: identical
  // across every attempt of ONE create, and never handed out again after it.
  //
  // `maxLength: 64` and the helper's default `cdkd-<hex>` spelling are the
  // documented constraints: "up to 64 ASCII characters", pattern `.+`
  // (CreateAccessPoint API reference), so no charset override is needed.
  const clientToken = acquireIdempotencyToken({
    scope: 'CreateAccessPoint',
    logicalId,
    maxLength: 64,
  });

  try {
    const response = await this.createOrAdoptAccessPoint(logicalId, resourceType, log, {
      ClientToken: clientToken.value,
      FileSystemId: fileSystemId,
      PosixUser: posixUser
        ? {
            Uid: Number(posixUser.Uid),
            Gid: Number(posixUser.Gid),
            SecondaryGids: posixUser.SecondaryGids?.map(Number),
          }
        : undefined,
      RootDirectory: rootDirectory
        ? {
            Path: rootDirectory.Path,
            CreationInfo: rootDirectory.CreationInfo
              ? {
                  OwnerUid: Number(rootDirectory.CreationInfo.OwnerUid),
                  OwnerGid: Number(rootDirectory.CreationInfo.OwnerGid),
                  Permissions: rootDirectory.CreationInfo.Permissions,
                }
              : undefined,
          }
        : undefined,
      Tags: tags?.map((t) => ({ Key: t.Key, Value: t.Value })),
    });

    const accessPointId = response.AccessPointId!;
    const arn = response.AccessPointArn!;

    log.debug(`Successfully created EFS AccessPoint ${logicalId}: ${accessPointId}`);

    // Success path ONLY, per `acquireIdempotencyToken`'s contract: releasing
    // on the failure path would hand the next attempt a different token and
    // reinstate the duplicate-create window the token exists to close.
    clientToken.release();

    return {
      physicalId: accessPointId,
      attributes: {
        Arn: arn,
        AccessPointId: accessPointId,
      },
    };
  } catch (error) {
    // A decline from `createOrAdoptAccessPoint` is ALREADY the diagnosis, and
    // re-wrapping it names the logical id twice while burying the remediation
    // command. Same guard as `route53/hosted-zone.ts` and
    // `fsx-filesystem-provider.ts`.
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create EFS AccessPoint ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * `CreateAccessPoint`, with the retry-replay case ADOPTED rather than failed
 * (issue [#2080](https://github.com/go-to-k/cdkd/issues/2080)).
 *
 * EFS REFUSES a repeated token -- `AccessPointAlreadyExists`, naming the
 * first access point's id -- which is what issue #2442 measured on real EFS,
 * whether or not the repeat's parameters matched. The first attempt's access point is then live AND absent from
 * state, which is the orphan the token exists to prevent, now with a failed
 * deploy on top, so this arm is the ORDINARY recovery path for a lost
 * response. A REPLAY of the first response was never observed, but nothing
 * documents that it cannot happen (see the DERIVATION note in
 * `createAccessPoint`); if it does, this method returns it like any other
 * success. `route53/hosted-zone.ts`'s `createOrAdoptHostedZone` is the same
 * pattern for the same issue family.
 *
 * Adoption is CONFIRMED rather than assumed, on four axes: the token (cdkd
 * mints a per-process value, so only an attempt of THIS create can hold it --
 * the parameter type requires one, so there is no "both undefined" way to
 * satisfy the comparison vacuously), the file system, and the `PosixUser` and
 * `RootDirectory` (issue #3894). The last three are structural rather than
 * contingent on the engine resolving properties once per create, which is
 * true today and is not this method's to rely on: because the refusal does
 * not depend on the parameters, a token re-sent with different ones would
 * otherwise be adopted. `PosixUser` and `RootDirectory` are compared through
 * EFS's defaults (`samePosixUser`, `sameRootDirectory`).
 *
 * Every way the confirmation can fail -- no id on the error, a read-back that
 * throws, a token, file system, POSIX user or root directory that does not
 * match, a description with no ARN -- DECLINES the adoption, says so at `warn`, and rethrows carrying the
 * AWS error as `cause`. A conflict cdkd cannot attribute to itself is not
 * something to paper over, and a lookup failure must never REPLACE the
 * diagnosis: a missing `elasticfilesystem:DescribeAccessPoints` permission
 * would otherwise surface as `AccessDenied` and send the next reader after a
 * permissions problem instead of the token collision that actually happened.
 *
 * The rethrow is WRAPPED rather than bare, and that is load-bearing rather
 * than cosmetic. `DeployEngine`'s replacement path classifies a failed
 * create-first attempt with `isNameCollisionErrorFrom`, which credits
 * `already exists` / `AlreadyExists` only when the TOP-LEVEL message relays
 * it -- and the raw AWS conflict carries both. A token collision misread as
 * a physical-NAME collision is not a cosmetic mistake: under `UpdateReplacePolicy: Retain` it
 * produces advice about renaming a resource that has no name, and under
 * `--replace` it falls back to delete-first, which DELETES the old access
 * point and then re-creates with the same still-unreleased token -- colliding
 * again, against the orphan rather than the old resource. Before this change
 * the create path could not raise an already-exists shape at all, so the
 * exposure arrives with the token. The AWS error is preserved as `cause`, so
 * nothing is lost; only the string the engine classifies on changes.
 */
export async function createOrAdoptAccessPoint(
  this: EFSProvider,
  logicalId: string,
  resourceType: string,
  log: MaskedLogSinks,
  input: CreateAccessPointCommandInput & { ClientToken: string }
): Promise<Pick<AccessPointDescription, 'AccessPointId' | 'AccessPointArn'>> {
  try {
    return await this.getClient().send(new CreateAccessPointCommand(input));
  } catch (error) {
    // `instanceof` alone is not enough -- but NOT for the reason it looks
    // like. Smithy's `ServiceException[Symbol.hasInstance]` matches on
    // `$fault && $metadata && name === this.name` rather than on prototype
    // identity, so a duplicate `@aws-sdk/client-efs` copy in the tree is
    // ALREADY covered by `instanceof`. What the string comparison adds is the
    // shape that carries the right `name` and none of the marker fields: a
    // re-thrown plain object, or a transport wrapper that lost them.
    const alreadyExists =
      error instanceof AccessPointAlreadyExists ||
      (error as { name?: string } | undefined)?.name === 'AccessPointAlreadyExists';
    if (!alreadyExists) {
      throw error;
    }
    // Everything below DECLINES rather than throws bare -- see the wrapping
    // note on this method. No message here interpolates a value out of
    // `properties`: `FileSystemId` can be an intrinsic that resolved to a
    // secret, and a provider's own `logger` line reaches no engine masking
    // sink (`.claude/rules/provider-masking.md`); `log` masks every line
    // here anyway, but only as a fallback. The logical id and the access
    // point id identify the resource without it.
    //
    // AWS-AUTHORED text is withheld for the same reason and one more. This
    // message is THROWN, so it reaches the durable `deployments/{runId}.jsonl`
    // event store, which outlives `cdkd destroy` -- and the headline
    // population of the read-back arm is a missing
    // `elasticfilesystem:DescribeAccessPoints`, whose AWS message names the
    // account id, the deploy role and the session. `describeAwsFailure` is
    // the repo's answer (`src/utils/aws-failure-text.ts`): its `summary`
    // names the failure CLASS and goes in the thrown message, its `detail`
    // carries AWS's own words to `debug`.
    //
    // Withholding that text also closes a classification channel, which is
    // the point of the wrap on this method rather than a bonus. AWS's
    // `AccessDenied` wording contains `not authorized to perform`, which is
    // an `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS` entry
    // (`src/deployment/retryable-errors.ts`), so interpolating it made a
    // PERMANENTLY missing grant retry on the dense IAM-propagation cadence --
    // 27 attempts re-issuing `CreateAccessPoint` for a permission that will
    // never appear. The trade is deliberate and one-directional: this decline
    // is now TERMINAL, which is right for a grant that is absent rather than
    // propagating.
    const decline = (reason: string): never => {
      log.warn(
        `CreateAccessPoint for ${logicalId} was refused because the idempotency token cdkd sent is already bound to an access point, and cdkd declined to adopt it: ${reason}.`
      );
      // `markNonRetryable` rather than trusting the wording: the message
      // interpolates a user-chosen `logicalId`, and
      // `RETRYABLE_ERROR_MESSAGE_PATTERNS` holds whitespace-free entries
      // (`DependencyViolation`, `QueueDeletedRecently`, ...), so a logical id
      // containing one would flip this deliberately-terminal decline back to
      // retryable.
      throw markNonRetryable(
        new ProvisioningError(
          `EFS refused CreateAccessPoint for ${logicalId}: the idempotency token cdkd sent is already bound to an access point, and cdkd could not confirm that access point is the one this deploy created (${reason}). That access point is NOT recorded in cdkd state -- find it with: ${withPasteableAwsProfile('aws efs describe-access-points')} --query "AccessPoints[?ClientToken=='${input.ClientToken}']"`,
          resourceType,
          logicalId,
          undefined,
          error instanceof Error ? error : undefined
        )
      );
    };

    const existingId = (error as { AccessPointId?: string } | undefined)?.AccessPointId;
    if (!existingId) {
      return decline('the conflict named no AccessPointId to read back');
    }

    let existing: AccessPointDescription | undefined;
    try {
      // RETRIED, because declining here costs more than declining anywhere
      // else in this method: a transient 500 on the CONFIRMATION would fail
      // the deploy AND leave the access point the first attempt created
      // live and unrecorded -- precisely the orphan the token exists to
      // prevent. The outer engine retry cannot cover it: `isTransientServerError`
      // walks `.cause`, which holds the 409 conflict rather than this 500.
      // Transient 5xx AND throttles. A modeled `@throws` list is not
      // exhaustive -- `DescribeAccessPoints` models only
      // `AccessPointNotFound` / `BadRequest` / `FileSystemNotFound` /
      // `InternalServerError`, yet AWS returns an unmodeled throttle on any
      // operation, arriving by NAME or as HTTP 429. Neither is a
      // `TRANSIENT_SERVER_ERROR_STATUS_CODES` entry, so a 5xx-only predicate
      // declines a throttled confirmation and strands the SAME orphan a 5xx
      // would. (Do not re-derive this from the modeled list and conclude the
      // clause is dead: EFS's own `ThrottlingException` is modeled on
      // `CreateAccessPoint`, not here.) An `AccessDenied` stays terminal
      // either way -- it is a grant that is absent rather
      // than propagating, and retrying it would spend the schedule on a
      // permission that will never appear -- the same waste the withheld
      // message above removes from the OUTER retry. Passing an explicit
      // predicate also opts out of the dense IAM-propagation ceiling.
      //
      // The watch is per-WAIT and never on `this` -- the provider is a
      // singleton serving concurrent resources, so a shared watch would let
      // one resource's Ctrl-C abort another's retry. Disposed in a `finally`.
      const watch = startInterruptWatch(`EFS AccessPoint ${logicalId} (adoption read-back)`);
      let described: DescribeAccessPointsCommandOutput;
      try {
        described = await withRetry(
          () =>
            this.getClient().send(new DescribeAccessPointsCommand({ AccessPointId: existingId })),
          logicalId,
          {
            maxRetries: 3,
            isRetryable: (_text, err) => isThrottlingError(err) || isTransientServerError(err),
            // The masked sink, not `this.logger`: `withRetry` puts AWS's
            // own text in its per-attempt and give-up lines (issue #2050).
            logger: log,
            isInterrupted: watch.isInterrupted,
            onInterrupted: watch.onInterrupted,
          }
        );
      } finally {
        watch.dispose();
      }
      existing = described.AccessPoints?.[0];
    } catch (lookupError) {
      // An INTERRUPT is not a lookup failure, and must escape before
      // `decline` can re-label it. `decline` sets `cause` to the
      // CreateAccessPoint conflict, which ERASES the interrupt from the
      // chain that `isInterruptedWaitError` walks -- so a Ctrl-C landing in
      // the backoff above would reach `deploy-engine.ts`'s failure branch
      // and roll the whole stack back automatically. That is the exact
      // outcome `interrupt-watch.ts` exists to prevent, and threading the
      // interrupt is what created the window. Same guard as
      // `dynamodb-globaltable-provider.ts` and `elbv2-provider.ts`.
      if (isInterruptedWaitError(lookupError)) throw lookupError;
      // The lookup error must never REPLACE the diagnosis, so the token
      // collision stays the headline and AWS's own words go to `debug`.
      const failure = describeAwsFailure(lookupError);
      log.debug(`Read-back of access point ${existingId} failed with: ${failure.detail}`);
      return decline(`reading access point ${existingId} back failed: ${failure.summary}`);
    }

    if (existing === undefined) {
      return decline(`access point ${existingId} could not be read back`);
    }
    if (existing.ClientToken !== input.ClientToken) {
      return decline(`access point ${existingId} carries a different ClientToken`);
    }
    if (existing.FileSystemId !== input.FileSystemId) {
      return decline(`access point ${existingId} belongs to a different file system`);
    }
    // EFS refuses a repeated token whether or not its parameters match
    // (issue #2442), so the token alone does not prove the access point is
    // the one THIS request described. The reasons name the field, never its
    // value -- same withholding as every other reason here.
    if (!samePosixUser(input.PosixUser, existing.PosixUser)) {
      return decline(`access point ${existingId} has a different PosixUser`);
    }
    if (!sameRootDirectory(input.RootDirectory, existing.RootDirectory)) {
      return decline(`access point ${existingId} has a different RootDirectory`);
    }
    if (!existing.AccessPointId) {
      return decline(`access point ${existingId} was read back without an id`);
    }
    if (!existing.AccessPointArn) {
      return decline(`access point ${existingId} was read back without an ARN`);
    }
    // An access point already on its way out, or wedged, must not be
    // recorded as this stack's physical id: the next command would resolve
    // state to a resource AWS is deleting or one that can never become
    // usable. `available`, `creating` and `updating` all pass -- this
    // provider has no access-point waiter, and a `creating` access point is
    // the normal answer to a replayed create.
    if (
      existing.LifeCycleState === 'deleting' ||
      existing.LifeCycleState === 'deleted' ||
      existing.LifeCycleState === 'error'
    ) {
      return decline(`access point ${existingId} is ${existing.LifeCycleState} rather than usable`);
    }

    log.warn(
      `CreateAccessPoint was replayed after a lost response; adopting the access point ${existing.AccessPointId} the previous attempt already created instead of creating a second one`
    );
    return existing;
  }
}

export async function deleteAccessPoint(
  this: EFSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting EFS AccessPoint ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(
      new DeleteAccessPointCommand({
        AccessPointId: physicalId,
      })
    );
    this.logger.debug(`Successfully deleted EFS AccessPoint ${logicalId}`);
  } catch (error) {
    if (error instanceof AccessPointNotFound) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`EFS AccessPoint ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
    throw this.wrapDeleteError(
      log,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete EFS AccessPoint ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
