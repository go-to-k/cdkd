import type { ELBv2Provider } from '../elbv2-provider.js';
import { LambdaClient } from '@aws-sdk/client-lambda';
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeListenersCommand,
  type TargetDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { RetryLogger } from '../../../deployment/retry.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import { waitForLambdaFunctionActive } from '../custom-resource-provider.js';
import { CdkdError, ProvisioningError } from '../../../utils/error-handler.js';
import type { DeleteContext } from '../../region-check.js';
import {
  createMaskedRetryLogger,
  maskerOrIdentity,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
  SecretMasker,
  ResourceIdentityVerdict,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import {
  wrapMaskedAwsError,
  markRedactedCause,
  relayedNameCollision,
} from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { hasErrorName } from '../create-ownership.js';
import { loadBalancerNameFromArn, recordedNameMask, elbv2ArnScope } from './shared.js';

/**
 * The failure wrap this provider's create, update and delete catches throw.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
 * assumed-role ARN. AWS's own text goes to `debug` through the operation's
 * masker, and the wrap is stamped `markRedactedCause`, so the retry
 * classifiers read the withheld text on the `cause` chain. An "already
 * exists" is restated ({@link relayedNameCollision}), so a create-first
 * replacement still recognises the collision, except from a post-create
 * wiring step's failure ({@link markAuxiliaryFailure}), where "it" would read
 * as this resource (#3826). A cdkd-authored or transport
 * error keeps its text, masked, stamped only when the mask changed it
 * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
 * an AWS one, unstamped (it has no chain). A delete catch tests not-found
 * before it wraps.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: ELBv2Provider,
  mask: MaskerFn,
  error: unknown,
  build: (text: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(`${mask(failure.summary)}${relay}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

export function getClient(this: ELBv2Provider): ElasticLoadBalancingV2Client {
  if (!this.elbv2Client) {
    this.elbv2Client = new ElasticLoadBalancingV2Client({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.elbv2Client;
}

/**
 * Wait for each Lambda target of a `lambda`-type target group to be
 * `State=Active` before RegisterTargets (go-to-k/cdkd#5002).
 * `LambdaFunctionProvider.create` returns while the function is `Pending`,
 * and registering a `Pending` function is rejected ("not in Active state").
 * The wait lives here, not in the Lambda provider, so no other deploy path
 * pays for it; any other target type returns before a Lambda client exists.
 */
export async function waitForLambdaTargetsActive(
  this: ELBv2Provider,
  logicalId: string,
  targetType: unknown,
  targets: TargetDescription[]
): Promise<void> {
  if (targetType !== 'lambda') return;
  for (const target of targets) {
    // `arn:<partition>:lambda:<region>:<account>:function:<name>[:<qualifier>]`
    const parts = typeof target.Id === 'string' ? target.Id.split(':') : [];
    if (parts[0] !== 'arn' || parts[2] !== 'lambda' || !parts[3]) {
      this.logger.debug(
        `Skipping the Active wait for target ${String(target.Id)} of ${logicalId}: not a Lambda function ARN`
      );
      continue;
    }
    const region = parts[3];
    let client = this.lambdaClients.get(region);
    if (!client) {
      client = new LambdaClient({ ...ambientClientDefaults(), region });
      this.lambdaClients.set(region, client);
    }
    const watch = startInterruptWatch(`ELBv2 TargetGroup ${logicalId} Lambda target wait`);
    const abort = new AbortController();
    const poll = setInterval(() => {
      if (watch.isInterrupted()) abort.abort();
    }, 1000);
    try {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      await waitForLambdaFunctionActive(client, target.Id as string, abort.signal);
    } catch (error) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      throw error;
    } finally {
      clearInterval(poll);
      watch.dispose();
    }
    this.logger.debug(`Lambda target ${target.Id} of ${logicalId} is Active`);
  }
}

/**
 * A {@link RetryLogger} for this provider's `withRetry` calls, bound to the
 * caller's secret masker (issue #2050).
 *
 * Thin wrapper over the shared {@link createMaskedRetryLogger} so the two
 * providers that need it cannot drift apart — see that module for why the
 * factory is shared rather than hand-rolled per file, and for the full
 * rationale on why `warn` is threaded rather than omitted.
 *
 * WHY NOT A `maskSecrets` OPTION ON `withRetry` (issue #2050 acceptance
 * item 3): `RetryLogger` is a structural type any caller can already satisfy
 * with a masking object — `drift.ts`'s revert has done exactly that since
 * issue #1914 — so the option would be a SECOND spelling of one intent
 * across ~50 existing call sites, and two spellings is how a later author
 * reaches for the unmasked one.
 */
export function maskedRetryLogger(
  this: ELBv2Provider,
  maskSecrets: SecretMasker | undefined
): RetryLogger {
  return createMaskedRetryLogger(this.logger, maskSecrets);
}

/**
 * Mask a caught AWS error's message before it is interpolated into a line
 * this provider logs (issue #2050, review round 2). A thrown `create()` /
 * `update()` / `delete()` failure goes through {@link wrapCaughtError}
 * instead, which names an AWS-authored failure by its class and masks the
 * rest the same way; the wrap is stamped when it withholds or masks.
 *
 * Masks `error.message` rather than the assembled sentence ON PURPOSE. The
 * two are NOT equivalent: handing the masker the raw message can reach
 * `maskSecretsInText`'s WHOLE-VALUE arm, which matches at ANY length, while
 * a longer assembled sentence can only ever reach the SUBSTRING arm, which
 * ignores needles below 4 characters. See `SecretMaskingContext` in
 * `src/types/resource.ts`.
 */
export function maskErrorMessage(
  this: ELBv2Provider,
  error: unknown,
  maskSecrets: SecretMasker | undefined
): string {
  const mask = maskerOrIdentity(maskSecrets);
  // `.detail`: the same text, without out-throwing the cleanup catch it runs
  // in on a value `String()` cannot convert (go-to-k/cdkd#3361).
  return mask(describeAwsFailure(error).detail);
}

/**
 * The cleanup-failure text a partial-create `warn` quotes after `head`, with
 * its closing period (go-to-k/cdkd#2319). An AWS-authored failure is named by
 * its CLASS at warn, since a denied `Delete*` names the caller's assumed-role
 * ARN; AWS's own text goes to `debug` under the same `head`, masked. A
 * cdkd-authored or transport error keeps its text, masked as
 * {@link maskErrorMessage} does.
 */
export function cleanupFailureText(
  this: ELBv2Provider,
  head: string,
  cleanupError: unknown,
  maskSecrets: SecretMasker | undefined
): string {
  const failure = describeAwsFailure(cleanupError);
  if (!failure.redacted) return `${this.maskErrorMessage(cleanupError, maskSecrets)}.`;
  const mask = maskerOrIdentity(maskSecrets);
  this.logger.debug(mask(`${head}${mask(failure.detail)}`));
  return mask(failure.summary);
}

/**
 * Whether a delete's `error` means its target is gone. go-to-k/cdkd#4606: a
 * journaled orphan's delete settles as done when it is gone, clearing its
 * only record, so only the type's own not-found error NAME counts there; a
 * record's own delete keeps the looser match.
 */
export function isDeleteTargetGone(
  this: ELBv2Provider,
  error: unknown,
  context: DeleteContext | undefined,
  notFoundName: string
): boolean {
  return context?.failedCreateOrphan === true
    ? hasErrorName(error, [notFoundName])
    : this.isNotFoundError(error);
}

/**
 * A delete whose target ELBv2 reports gone. go-to-k/cdkd#4606: a journaled
 * orphan already gone settles with exit 0, so it is named once at info
 * (masked by the caller's printing bag); a record's own delete keeps the
 * quiet `debugText`.
 */
export function logDeleteTargetGone(
  this: ELBv2Provider,
  context: DeleteContext | undefined,
  what: string,
  physicalId: string,
  logicalId: string,
  debugText: string
): void {
  if (context?.failedCreateOrphan === true) {
    this.logger.info(
      safeMsg`  ${what} ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
    );
  } else {
    this.logger.debug(debugText);
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────

/**
 * `create()` reads `context` for ONE thing: `maskSecrets` (issue #2050). The
 * Listener create path runs a post-create `ModifyListenerAttributes` through
 * `withRetry`, whose per-attempt `debug` line and give-up `warn` summary
 * interpolate the AWS message verbatim — and that payload is built from
 * RESOLVED template properties. See {@link maskedRetryLogger}.
 *
 * The LoadBalancer arm receives it too (issue #2063). It runs no `withRetry`,
 * but it has the two surfaces that do not need one: the `ProvisioningError`
 * its catch throws (printed at ERROR — DEFAULT verbosity — by
 * `deploy-engine.ts`) and its partial-create cleanup `warn`. Its payload is
 * `Name` / `Subnets` / `SecurityGroups` / `LoadBalancerAttributes` values /
 * `Tags` values straight out of the resolved bag, and AWS quotes a rejected
 * value back.
 */
export async function create(
  this: ELBv2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  switch (resourceType) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      return this.createLoadBalancer(logicalId, resourceType, properties, context?.maskSecrets);
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      return this.createTargetGroup(logicalId, resourceType, properties, context?.maskSecrets);
    case 'AWS::ElasticLoadBalancingV2::Listener':
      return this.createListener(logicalId, resourceType, properties, context?.maskSecrets);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

/**
 * `context` is read for ONE thing today: `maskSecrets` (issue #2050) — the
 * update-path twin of the `create()` note above.
 *
 * The catch below is the LoadBalancer arm's masking site (issue #2063), and
 * the reason that arm needs no `maskSecrets` parameter of its own.
 * `updateLoadBalancer` has no try/catch: its `ModifyLoadBalancerAttributes` /
 * `SetSubnets` / `SetSecurityGroups` / `AddTags` rejections — every one of
 * them built from the resolved `properties` bag — propagate RAW to here.
 * The sibling arms wrap their own errors into a `ProvisioningError` first,
 * so the `CdkdError` passthrough short-circuits them and this frame masks
 * only what actually escapes unwrapped.
 */
export async function update(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  try {
    return await this.applyUpdate(
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  } catch (error) {
    // Pass through every cdkd-typed error untouched: ResourceUpdateNotSupportedError
    // is control flow the deploy engine matches BY CLASS, and an inner
    // ProvisioningError already carries better context than a re-wrap.
    if (error instanceof CdkdError) throw error;
    const cause = error instanceof Error ? error : undefined;
    // The LoadBalancer arm has no wrap of its own, and AWS echoes its ARN,
    // which carries a pre-rotation secret-derived name the deploy's masker
    // never resolved (go-to-k/cdkd#4339).
    const mask =
      resourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer'
        ? recordedNameMask(
            context?.maskSecrets,
            previousProperties['Name'],
            loadBalancerNameFromArn(physicalId)
          )
        : maskerOrIdentity(context?.maskSecrets);
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update ELBv2 resource ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function applyUpdate(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  switch (resourceType) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      return this.updateLoadBalancer(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets,
        context?.desiredFromAwsReadback === true
      );
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      return this.updateTargetGroup(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets,
        context?.desiredFromAwsReadback === true
      );
    case 'AWS::ElasticLoadBalancingV2::Listener':
      return this.updateListener(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function deleteImpl(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  switch (resourceType) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      return this.deleteLoadBalancer(logicalId, physicalId, resourceType, context);
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      return this.deleteTargetGroup(logicalId, physicalId, resourceType, context);
    case 'AWS::ElasticLoadBalancingV2::Listener':
      return this.deleteListener(logicalId, physicalId, resourceType, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

/**
 * go-to-k/cdkd#4606: whether the load balancer, target group or listener a
 * failed CREATE journaled is the one the record under the same logical id
 * holds (a fix-forward that created a new one there).
 *
 * The identity is the ARN, the physical id on both routes. Its last
 * segment(s) are an id AWS mints per create, so even a load balancer or
 * target group re-created under the same NAME gets another ARN, and none of
 * the three can be renamed: two distinct ARNs of one type name two distinct
 * resources. The name alone is no identity (it is reusable once the holder
 * is deleted), so anything but the type's ARN form is `'unknown'`, as are
 * two ARNs outside the stack's region or of different partitions or
 * accounts. Equal ARNs are `'same'` without a read. After the client-region
 * check, the record's ARN must read back as itself (else `'unknown'`); the
 * journaled one is then `'different'` when it reads back as itself or AWS
 * reports it gone (a listener whose load balancer was deleted included),
 * `'same'` when it reads back as the record's, and `'unknown'` for any
 * other answer.
 *
 * SDK-routed resources only: the settle asks the provider the journaled
 * operation was provisioned by, and only this provider's creates journal
 * one (`markCreatedBeforeFailure`, when the wiring-failure cleanup could
 * not delete what the create made).
 */
export async function isSameResource(
  this: ELBv2Provider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  const journaledScope = elbv2ArnScope(resourceType, journaledPhysicalId);
  const recordScope = elbv2ArnScope(resourceType, record.physicalId);
  if (journaledScope === undefined || journaledScope !== recordScope) return 'unknown';
  if (journaledPhysicalId === record.physicalId) return 'same';
  if (journaledScope.split(':')[1] !== context.expectedRegion) return 'unknown';
  const clientRegion = await this.getClient().config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  if ((await this.readElbv2ArnIfExists(resourceType, record.physicalId)) !== record.physicalId) {
    return 'unknown';
  }
  const journaledLive = await this.readElbv2ArnIfExists(resourceType, journaledPhysicalId);
  if (journaledLive === record.physicalId) return 'same';
  return journaledLive === undefined || journaledLive === journaledPhysicalId
    ? 'different'
    : 'unknown';
}

/**
 * The ARN `Describe*` reports for `arn` of `resourceType`, or `undefined`
 * when ELBv2 reports it gone by the type's own not-found error NAME. Any
 * other failure, and a response naming no single resource, throws: "could
 * not read" never reads as "gone".
 */
export async function readElbv2ArnIfExists(
  this: ELBv2Provider,
  resourceType: string,
  arn: string
): Promise<string | undefined> {
  let notFoundName: string;
  let read: () => Promise<Array<string | undefined> | undefined>;
  switch (resourceType) {
    case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
      notFoundName = 'LoadBalancerNotFoundException';
      read = async () =>
        (
          await this.getClient().send(new DescribeLoadBalancersCommand({ LoadBalancerArns: [arn] }))
        ).LoadBalancers?.map((lb) => lb.LoadBalancerArn);
      break;
    case 'AWS::ElasticLoadBalancingV2::TargetGroup':
      notFoundName = 'TargetGroupNotFoundException';
      read = async () =>
        (
          await this.getClient().send(new DescribeTargetGroupsCommand({ TargetGroupArns: [arn] }))
        ).TargetGroups?.map((tg) => tg.TargetGroupArn);
      break;
    case 'AWS::ElasticLoadBalancingV2::Listener':
      notFoundName = 'ListenerNotFoundException';
      read = async () =>
        (
          await this.getClient().send(new DescribeListenersCommand({ ListenerArns: [arn] }))
        ).Listeners?.map((l) => l.ListenerArn);
      break;
    default:
      throw new Error(`No ELBv2 identity read for ${resourceType}`);
  }
  let arns: Array<string | undefined> | undefined;
  try {
    arns = await read();
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === notFoundName) return undefined;
    throw error;
  }
  const found = arns ?? [];
  if (found.length !== 1 || typeof found[0] !== 'string' || found[0] === '') {
    throw new Error('ELBv2 did not return exactly the resource asked for');
  }
  return found[0];
}

/**
 * Check if an error indicates the resource was not found
 */
export function isNotFoundError(this: ELBv2Provider, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = (error.message || '').toLowerCase();
  const name = (error as { name?: string }).name ?? '';
  return (
    message.includes('not found') ||
    message.includes('does not exist') ||
    name === 'LoadBalancerNotFoundException' ||
    name === 'TargetGroupNotFoundException' ||
    name === 'ListenerNotFoundException'
  );
}
