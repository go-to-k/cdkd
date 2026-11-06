import {
  CreateTagsCommand,
  DeleteTagsCommand,
  type ResourceType as Ec2TagResourceType,
  type TagSpecification,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { planTagDiff, tagPlanWarning, type CfnTagEntry } from '../../tag-list.js';
import { type MaskerFn } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  explicitDenyPolicyKind,
  isExplicitDenyError,
  markNonRetryable,
  markRedactedCause,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import {
  CDKD_NOTES,
  CREATE_TAGS_DENIAL_NAMES,
  IDEMPOTENT_MISMATCH_NAMES,
  INSTANCE_NOT_FOUND_NAMES,
  LAUNCHED_INSTANCE_VISIBILITY_ATTEMPTS,
  isCreateTagsDenial,
  isNamedError,
  redactedEc2FailureText,
} from './common.js';
import type { EC2Provider } from '../ec2-provider.js';

/**
 * Send one of the nine tagged creates (go-to-k/cdkd#4971) with the template's
 * tags in `TagSpecifications`, as CloudFormation sends them, so an SCP
 * requiring `aws:RequestTag/...` on the create action sees them. `send`
 * builds and sends the create, with `TagSpecifications` when given one.
 *
 * `tagsApplied` says whether the created resource already carries the tags;
 * when it is `false` the caller tags it with {@link applyTags}, the path
 * every create took before (and a no-op for a template declaring none).
 *
 * Tags on a create need `ec2:CreateTags` (measured for all nine). Before
 * this change the follow-up `CreateTags` only WARNED on failure, so a role
 * without it could still create, untagged. To keep that working, a tagged
 * create denied `ec2:CreateTags` ({@link isCreateTagsDenial}) is re-sent ONCE
 * without `TagSpecifications` and `tagsApplied` is `false`; the extra call is
 * spent only by such a role, never by one the tagged create succeeds for. A
 * `ClientToken` the denied attempt carried is reusable: EC2 records no token
 * for a request it refused (measured). An `IdempotentParameterMismatch` on
 * the tagged send takes the same re-send ({@link IDEMPOTENT_MISMATCH_NAMES}).
 * When the untagged re-send is denied too (an SCP requiring request tags,
 * say), the `ec2:CreateTags` denial is the one surfaced, since granting it
 * lets the tagged create through, with a fixed note that the re-send was
 * refused too (and the policy type of an explicit deny) appended to its
 * message, so a role missing the create action itself is told so in the
 * same run without echoing AWS's text; marked non-retryable when the re-send's denial was an explicit
 * deny, which no wait lifts. Any other answer from the re-send is its own.
 */
export async function sendTaggedCreate<T>(
  this: EC2Provider,
  logicalId: string,
  tagResourceType: Ec2TagResourceType,
  tags: CfnTagEntry[],
  send: (tagSpecifications: TagSpecification[] | undefined) => Promise<T>
): Promise<{ response: T; tagsApplied: boolean }> {
  if (tags.length === 0) return { response: await send(undefined), tagsApplied: false };
  const tagSpecifications: TagSpecification[] = [
    { ResourceType: tagResourceType, Tags: tags.map((t) => ({ Key: t.Key, Value: t.Value })) },
  ];
  try {
    return { response: await send(tagSpecifications), tagsApplied: true };
  } catch (taggedError) {
    const tagsDenied = isCreateTagsDenial(taggedError);
    if (!tagsDenied && !isNamedError(taggedError, IDEMPOTENT_MISMATCH_NAMES)) throw taggedError;
    this.logger.debug(
      safeMsg`Create of ${logicalId} with tags was ${tagsDenied ? 'denied ec2:CreateTags' : 'refused for a client token an untagged create already used'}; ` +
        `retrying without tags and applying them with CreateTags`
    );
    try {
      return { response: await send(undefined), tagsApplied: false };
    } catch (untaggedError) {
      if (
        !tagsDenied ||
        !(taggedError instanceof Error) ||
        !isNamedError(untaggedError, CREATE_TAGS_DENIAL_NAMES)
      ) {
        throw untaggedError;
      }
      this.logger.debug(
        safeMsg`Create of ${logicalId} without tags was denied too; reporting the ec2:CreateTags denial`
      );
      // The re-send's AWS text names the caller's session and may carry a
      // policy ARN, so it goes to debug only; the thrown message gets a
      // FIXED note, the policy type taken from a constant list (the S3
      // #4972 shape, `explicitDenyPolicyKind`).
      const untaggedDetail = describeAwsFailure(untaggedError).detail;
      this.logger.debug(
        safeMsg`Create of ${logicalId} without tags was refused: ${untaggedDetail}`
      );
      const explicit = isExplicitDenyError(untaggedDetail);
      const kind = explicit ? explicitDenyPolicyKind(untaggedDetail) : undefined;
      const note =
        ` The create without tags was refused too (UnauthorizedOperation)` +
        `${explicit ? `; explicit deny${kind !== undefined ? ` (${kind})` : ''}` : ''}.`;
      taggedError.message = `${taggedError.message}${note}`;
      // The create's wrap names this AWS-authored error by its class only
      // (go-to-k/cdkd#2319), so it re-appends the note from here.
      CDKD_NOTES.set(taggedError, note);
      if (explicit) markNonRetryable(taggedError);
      throw taggedError;
    }
  }
}

/**
 * Apply tags to an EC2 resource (create-time, no removal).
 *
 * Used by a `create*` path whose create did not carry the tags
 * ({@link sendTaggedCreate}'s `tagsApplied`). Update paths should use
 * `applyTagDiff` instead to handle tag removal too.
 */
export async function applyTags(
  this: EC2Provider,
  resourceId: string,
  tags: CfnTagEntry[],
  logicalId: string,
  mask: MaskerFn,
  wrapSend: <T>(call: () => Promise<T>) => Promise<T> = (call) => call()
): Promise<void> {
  if (tags.length > 0) {
    try {
      await wrapSend(() =>
        this.ec2Client.send(
          new CreateTagsCommand({
            Resources: [resourceId],
            Tags: tags.map((t) => ({ Key: t.Key, Value: t.Value })),
          })
        )
      );
      this.logger.debug(`Applied ${tags.length} tag(s) to ${logicalId}`);
    } catch (error) {
      const tagHead = `Failed to apply tags to ${logicalId}: `;
      this.logger.warn(`${tagHead}${this.warnFailureText(tagHead, error, mask)}`);
    }
  }
}

/**
 * Apply a diff between old and new CFn-shape Tags arrays via EC2's
 * `CreateTags` / `DeleteTags` APIs. Used by `update*` paths so that
 * tag removals reach AWS too. EC2 keys both APIs by a list of resource
 * ids. Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
 * unreadable record untags nothing.
 */
export async function applyTagDiff(
  this: EC2Provider,
  resourceId: string,
  resourceType: string,
  logicalId: string,
  oldTagsRaw: unknown,
  newTagsRaw: unknown,
  mask: MaskerFn
): Promise<void> {
  const plan = planTagDiff(oldTagsRaw, newTagsRaw);
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));
  const tagsToRemove = plan.remove.map((Key) => ({ Key }));

  if (tagsToRemove.length > 0) {
    try {
      await this.ec2Client.send(
        new DeleteTagsCommand({
          Resources: [resourceId],
          Tags: tagsToRemove,
        })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from ${resourceId}`);
    } catch (error) {
      const tagHead = `Failed to remove tags from ${resourceId}: `;
      this.logger.warn(`${tagHead}${this.warnFailureText(tagHead, error, mask)}`);
    }
  }
  if (tagsToAdd.length > 0) {
    try {
      await this.ec2Client.send(
        new CreateTagsCommand({
          Resources: [resourceId],
          Tags: tagsToAdd,
        })
      );
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on ${resourceId}`);
    } catch (error) {
      const tagHead = `Failed to add tags on ${resourceId}: `;
      this.logger.warn(`${tagHead}${this.warnFailureText(tagHead, error, mask)}`);
    }
  }
}

/**
 * Retry an operation that AWS may reject with `DependencyViolation`
 * for an extended window — specifically `DeleteInternetGateway` and
 * `DetachInternetGateway` after a sibling EC2 Instance with an
 * auto-assigned public IP was terminated. AWS releases the public-IP
 * → IGW mapping asynchronously (5–10 min lag observed in practice);
 * during that window AWS rejects IGW-detach / -delete with
 * `DependencyViolation: Network has some mapped public address(es).
 * Please unmap those public address(es) before detaching the gateway.`
 * (or similar `has dependencies and cannot be deleted`).
 *
 * cdkd's deploy-engine `withRetry` wrapper caps at ~1 min total
 * (1s/2s/4s/8s × 10 attempts capped at 8s), and the destroy-runner's
 * inner 3-attempt loop adds ~35s on top — neither is enough for
 * AWS's 5–10 min release window. This helper extends the budget to
 * 10 min for the IGW-specific case so `cdkd destroy
 * --remove-protection` is self-healing on the public-IP release lag
 * without operator intervention.
 *
 * Modeled on the Lambda hyperplane ENI cleanup pattern (~30 min
 * budget) and the EC2 Subnet/SG side-channel ENI retry — both wait
 * on AWS-side eventual-consistency that the standard `withRetry`
 * budget cannot cover.
 *
 * Only `DependencyViolation` errors are retried; other errors
 * (NotFound, AccessDenied, throttle, etc.) propagate immediately so
 * the caller's existing error handling is unchanged.
 *
 * Note on retry layering: `DependencyViolation` is also in
 * `RETRYABLE_ERROR_MESSAGE_PATTERNS` (consumed by `withRetry`) and
 * the destroy-runner's inner 3-attempt loop also matches it. After
 * this helper's budget exhausts and re-throws, those outer retry
 * loops will see the error and try a few more times — adding at
 * most ~1 min on top of the 10 min budget, still bounded by the
 * per-resource `--resource-timeout` deadline (default 30 min).
 * That extra is harmless (worst case slightly later failure surface)
 * and avoids threading a per-error-class "already exhausted" flag
 * through every retry layer.
 */
export async function withDependencyViolationRetry<T>(
  this: EC2Provider,
  operation: () => Promise<T>,
  opts: { description: string; totalBudgetMs?: number }
): Promise<T> {
  const totalBudgetMs = opts.totalBudgetMs ?? 600_000; // 10 min default
  const initialDelayMs = 5_000;
  const maxDelayMs = 10_000;
  const startedAt = Date.now();

  let attempt = 0;
  let delay = initialDelayMs;
  // Loop forever — exit conditions are (a) operation succeeds (return),
  // (b) operation throws non-DependencyViolation (re-throw immediately),
  // (c) elapsed >= budget AND operation still throws DependencyViolation
  // (re-throw the last DependencyViolation error).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!this.isDependencyViolationError(error)) {
        throw error;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= totalBudgetMs) {
        throw error;
      }
      attempt += 1;
      const sleepMs = Math.min(delay, totalBudgetMs - elapsed);
      const message = describeAwsFailure(error).detail;
      this.logger.debug(
        `${opts.description}: dependency still mapped (attempt ${attempt}, retrying in ${sleepMs}ms): ${message}`
      );
      await this.sleep(sleepMs);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
}

/**
 * Wrap what an EC2 operation caught into the error it throws, keeping the
 * caller's identity out of the thrown message (go-to-k/cdkd#2319; the Glue
 * twin is `wrapGlueError`).
 *
 * A thrown message is persisted to `deployments/{runId}.jsonl`, and EC2
 * words an `UnauthorizedOperation` as `You are not authorized to perform
 * this operation. User: arn:aws:sts::<account>:assumed-role/<role>/<session>
 * is not authorized to perform: ...`. So an AWS-authored failure
 * (`describeAwsFailure`) reaches `build` as its class
 * ({@link redactedEc2FailureText}), and the message `build` would have made
 * from AWS's own text goes to `debug`. A cdkd-authored or transport error
 * keeps its text, byte-identical to before.
 *
 * `build` must thread `error` as the wrap's `cause`: the redaction is
 * stamped (`markRedactedCause`) so the retry classifiers read that chain,
 * where the withheld `not authorized to perform` still is. A non-`Error`
 * throw has no chain, so it is not stamped. Every caller tests its own
 * not-found and `DependencyViolation` wording on the CAUGHT error before
 * wrapping, so no decision here reads the shortened message.
 *
 * `mask` is the operation's secret masker: AWS can echo a resolved value
 * back, so the debug line is masked raw and as the finished line, and the
 * class itself goes through it. A cdkd-authored or transport error keeps
 * its text, masked, stamped only when the mask changed it
 * (`wrapMaskedAwsError`, issue #4244).
 */
export function wrapCaughtError(
  this: EC2Provider,
  mask: MaskerFn,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  // `build` runs twice here (debug text, then the throw), so it must stay a
  // side-effect-free constructor call.
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const wrapped = build(redactedEc2FailureText(mask, error, failure));
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * The failure text a default-level `warn` quotes after `head`
 * (go-to-k/cdkd#2319). An AWS-authored failure is named by its CLASS, since
 * a denied `Delete*` or `CreateTags` names the caller's assumed-role ARN;
 * AWS's own text goes to `debug` under the same `head`, through `mask`. A
 * cdkd-authored or transport error keeps its text, masked and otherwise
 * unchanged, as `wrapMaskedAwsError` relays it into a thrown wrap.
 */
export function warnFailureText(
  this: EC2Provider,
  head: string,
  error: unknown,
  mask: MaskerFn
): string {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return mask(failure.detail);
  this.logger.debug(mask(`${head}${mask(failure.detail)}`));
  return mask(failure.summary);
}

/**
 * {@link warnFailureText} for a `warn` that goes on with another sentence:
 * the text, closed with a period unless it already ends one.
 */
export function warnFailureSentence(
  this: EC2Provider,
  head: string,
  error: unknown,
  mask: MaskerFn
): string {
  const text = this.warnFailureText(head, error, mask);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The delete catches' {@link wrapCaughtError}. The wrap names an AWS failure
 * by its CLASS, and the delete classifiers read `NotFound` in a message as
 * "already deleted": a class naming another object's not-found (a
 * `KMSNotFoundException`) would drop the state record of a live resource.
 * Each caller tests its own not-found on the CAUGHT error first
 * (`isNotFoundError`), so a `NotFound` class reaching here is not this
 * resource's, and the wrap is marked {@link markNotGone}
 * (go-to-k/cdkd#2319, #5228).
 */
export function wrapDeleteError(
  this: EC2Provider,
  mask: MaskerFn,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const thrown = this.wrapCaughtError(mask, error, build);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

/**
 * Match an AWS `DependencyViolation` error by error code or message.
 * AWS surfaces this as `Code: 'DependencyViolation'` in the parsed SDK
 * error, with a human message like `The internetGateway 'igw-xxx' has
 * dependencies and cannot be deleted.` or `Network has some mapped
 * public address(es). Please unmap those public address(es)`.
 */
export function isDependencyViolationError(this: EC2Provider, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { Code?: string; name?: string }).Code ?? '';
  const name = (error as { name?: string }).name ?? '';
  if (code === 'DependencyViolation' || name === 'DependencyViolation') return true;
  const message = error.message ?? '';
  return (
    message.includes('DependencyViolation') ||
    message.includes('has dependencies and cannot be deleted') ||
    message.includes('Network has some mapped public address')
  );
}

/**
 * AWS rejects AssociateAddress (and several other instance operations)
 * against an instance that is not `running` / `stopped` with the
 * `IncorrectInstanceState` code. Under --no-wait that is the expected
 * outcome for an instance created in the same deploy, not a transient
 * fault -- it stays true exactly until the wait --no-wait skipped would
 * have completed.
 */
export function isIncorrectInstanceStateError(this: EC2Provider, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { Code?: string }).Code ?? '';
  const name = (error as { name?: string }).name ?? '';
  if (code === 'IncorrectInstanceState' || name === 'IncorrectInstanceState') return true;
  return error.message.includes('IncorrectInstanceState');
}

/**
 * go-to-k/cdkd#5630: run a call against the instance `RunInstances` JUST
 * returned, retrying it while EC2 still answers `InvalidInstanceID.NotFound`.
 *
 * EC2's API is eventually consistent: a `DescribeInstances` (or modify) sent
 * the moment `RunInstances` returns can answer that the id it just handed
 * out does not exist (measured: us-east-1, 2026-11-04, under `--no-wait`,
 * where no running-state waiter sits in between). Letting that reach
 * `createInstance`'s wiring catch TERMINATES the healthy instance, and its
 * `does not exist` message is retryable to the deploy engine, which re-runs
 * the create under a new client token: a second launch, which for a fixed
 * `PrivateIpAddress` / `Ipv6Addresses` collides with the address the
 * terminating instance still holds (`InvalidIPAddress.InUse`). CloudFormation
 * never relaunches an instance because a read lagged; retrying the READ is
 * the fix. Any other error, and a NotFound outlasting the bounded budget
 * (~40s), propagates unchanged.
 */
export async function whileLaunchedInstanceNotVisible<T>(
  this: EC2Provider,
  logicalId: string,
  instanceId: string,
  call: () => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (
        attempt >= LAUNCHED_INSTANCE_VISIBILITY_ATTEMPTS ||
        !isNamedError(error, INSTANCE_NOT_FOUND_NAMES)
      ) {
        throw error;
      }
      this.logger.debug(
        safeMsg`EC2 Instance ${logicalId} (${instanceId}) is not visible yet after launch (attempt ${String(attempt)}); retrying`
      );
      await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    }
  }
}

/**
 * Indirect sleep so unit tests can swap in a fake-timer-aware
 * implementation via `vi.useFakeTimers()` without monkey-patching
 * `setTimeout` globally.
 */
export function sleep(this: EC2Provider, ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error indicates the resource was not found
 */
export function isNotFoundError(this: EC2Provider, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  const name = (error as { name?: string }).name ?? '';
  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    message.includes('invalidparametervalue') ||
    name === 'InvalidVpcID.NotFound' ||
    name === 'InvalidSubnetID.NotFound' ||
    name === 'InvalidInternetGatewayID.NotFound' ||
    name === 'InvalidVpnGatewayID.NotFound' ||
    name === 'InvalidVpnGatewayAttachment.NotFound' ||
    name === 'InvalidRouteTableID.NotFound' ||
    name === 'InvalidGroup.NotFound' ||
    name === 'InvalidAssociationID.NotFound' ||
    name === 'InvalidRoute.NotFound' ||
    name === 'InvalidInstanceID.NotFound' ||
    name === 'InvalidNetworkAclID.NotFound' ||
    name === 'InvalidNetworkAclEntry.NotFound' ||
    name === 'InvalidAllocationID.NotFound' ||
    name === 'InvalidAddressID.NotFound'
  );
}

/** The {@link EC2Provider} methods this module defines. */
export const tagsErrorsMethods = {
  sendTaggedCreate,
  applyTags,
  applyTagDiff,
  withDependencyViolationRetry,
  wrapCaughtError,
  warnFailureText,
  warnFailureSentence,
  wrapDeleteError,
  isDependencyViolationError,
  isIncorrectInstanceStateError,
  whileLaunchedInstanceNotVisible,
  sleep,
  isNotFoundError,
};
