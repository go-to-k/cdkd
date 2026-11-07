import type { RDSDBProxyProvider } from '../rds-dbproxy-provider.js';
import {
  ModifyDBProxyCommand,
  DescribeDBProxiesCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  type Tag,
} from '@aws-sdk/client-rds';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import {
  planTagDiff,
  tagPlanWarning,
  refuseMalformedDesiredTags,
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
} from '../../tag-list.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  withDerivedNameMasks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { injectiveKey } from '../../../state/record-keys.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  RETAINED_ON_REMOVAL,
  CFN_KEEPS_ON_REMOVAL,
  authRemovalRefused,
  leavesProxyWithoutAuth,
} from './shared.js';

export async function update(
  this: RDSDBProxyProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(
    properties['Tags'],
    resourceType,
    logicalId,
    physicalId,
    'Tags',
    DBPROXY_TAGS_WHAT,
    DBPROXY_TAG_OPTIONS
  );
  // Issue #1160: an Auth removal CloudFormation's update fails on is refused
  // before any call (`authRemovalRefused`). Not on a rollback replay or
  // `drift --revert`: neither removes anything from a template. A replay
  // keeps the live Auth and warns; `drift --revert` passes an empty removed
  // set, so it keeps the live Auth without a warning.
  if (
    context?.replayingState !== true &&
    context?.desiredFromAwsReadback !== true &&
    this.removedRetained(properties, previousProperties, context).includes('Auth') &&
    authRemovalRefused(properties, previousProperties)
  ) {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${logicalId} (${resourceType}): Auth was removed from the template, but AWS requires Auth while DefaultAuthScheme is NONE or unset, and CloudFormation's update fails on the same change. Declare Auth again; nothing was changed.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }
  // go-to-k/cdkd#2762: an update that leaves the proxy with no Auth while the
  // scheme it will hold requires one is refused before any call, the same
  // way: AWS requires Auth under NONE, so ModifyDBProxy would only fail
  // later. Two shapes reach that call: a switch TO `DefaultAuthScheme: NONE`
  // whose template declares no Auth (absent, `null` or `[]`), and a changed
  // Auth declared EMPTY while the kept scheme is NONE or unset. (A REMOVED
  // Auth is the refusal above; an absent Auth with no scheme change sends
  // nothing.) Not on a rollback replay or `drift --revert`, whose desired bag
  // is not a template.
  if (
    context?.replayingState !== true &&
    context?.desiredFromAwsReadback !== true &&
    leavesProxyWithoutAuth(properties, previousProperties)
  ) {
    throw markNonRetryable(
      new ProvisioningError(
        safeMsg`${logicalId} (${resourceType}): the update leaves the proxy with no Auth while DefaultAuthScheme is NONE or unset, and AWS requires Auth then. Declare Auth; nothing was changed.`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  const client = this.getClient();
  // The physical id IS the proxy name, which can be secret-derived. Paired
  // with the RECORDED name (go-to-k/cdkd#4339): after a secret rotation the
  // physical id is the PRE-rotation value, which this deploy's masker never
  // resolved, and a previous side still spelling `{{resolve:` makes it a
  // needle. The guard below keeps the deploy's own masker; every message of
  // this update reads this one.
  const { mask } = withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    [[previousProperties['DBProxyName'], physicalId]]
  );

  // Defensive: reject diffs in immutable fields. Replacement-rules.ts
  // SHOULD have routed those to a CREATE+DELETE replacement upstream, but
  // we double-check here so a missing rule entry doesn't silently corrupt
  // state (the PR #387 round 1 blocker class). A secret-derived value is
  // recorded as its `{{resolve:...}}` reference and handed here resolved,
  // which is no change; the physical id IS the proxy name
  // (go-to-k/cdkd#4275).
  for (const field of [
    'DBProxyName',
    'EngineFamily',
    'VpcSubnetIds',
    'EndpointNetworkType',
    'TargetConnectionNetworkType',
  ]) {
    if (
      JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field]) &&
      !(await unchangedBehindSecretReference({
        resourceType,
        key: field,
        desired: properties[field],
        previous: previousProperties[field],
        physicalName: field === 'DBProxyName' ? physicalId : undefined,
        maskSecrets: context?.maskSecrets,
      }))
    ) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `${field} is immutable on AWS::RDS::DBProxy — destroy + redeploy to change it`
      );
    }
  }

  const input: Record<string, unknown> = { DBProxyName: physicalId };
  let hasModify = false;
  const mutableFields: Array<keyof typeof properties> = [
    'Auth',
    'DefaultAuthScheme',
    'RequireTLS',
    'IdleClientTimeout',
    'DebugLogging',
    'RoleArn',
    'VpcSecurityGroupIds',
  ];
  for (const key of mutableFields) {
    // A removed field has nothing to send: ModifyDBProxy keeps an omitted
    // setting (warned about below), so it never makes a call by itself.
    if (properties[key] === undefined) continue;
    if (JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key])) {
      // Translate VpcSecurityGroupIds → SecurityGroups (CFn → SDK shape).
      const sdkKey = key === 'VpcSecurityGroupIds' ? 'SecurityGroups' : key;
      input[sdkKey] = properties[key];
      hasModify = true;
    }
  }

  if (hasModify) {
    this.logger.debug(
      `Updating DBProxy ${mask(physicalId)}: ${Object.keys(input)
        .filter((k) => k !== 'DBProxyName')
        .join(', ')}`
    );
    try {
      await client.send(new ModifyDBProxyCommand(input as never));
    } catch (error) {
      throw this.wrapCaughtError(error, 'UPDATE', resourceType, logicalId, physicalId, mask);
    }
    // ModifyDBProxy returns while the proxy is `modifying`. Wait for
    // `available` before returning, as create() does: a dependent's update
    // in the same deploy, or the next modify, is refused with
    // InvalidDBProxyStateFault while it is still `modifying`.
    await this.waitForAvailableAfterModify(physicalId, resourceType, logicalId, mask);
  }

  // Invalidate attribute cache BEFORE applyTagDiff so the ARN warm-up
  // applyTagDiff performs survives across the update() call boundary
  // (PR #400 review M1: previously evicting after applyTagDiff wasted
  // the warm-up the next update() pays a Describe to re-create).
  this.invalidateAttributeCache(physicalId);

  // Tag diff via separate Add/Remove APIs.
  await this.applyTagDiff(
    physicalId,
    previousProperties['Tags'],
    properties['Tags'],
    resourceType,
    logicalId,
    mask
  );

  // Only once the update succeeded, as the shared removal warning is: the
  // caller retries the whole update(), and a failed one leaves the previous
  // state in place, so the next deploy warns again.
  this.warnOnRetainedRemovals(logicalId, resourceType, properties, previousProperties, context);

  return { physicalId, wasReplaced: false };
}

/**
 * Polls `DescribeDBProxies` until the proxy reports `available` after a
 * `ModifyDBProxy`, bounded by the same deadline as create(). A terminal
 * failure state or the deadline is a `ProvisioningError`.
 */
export async function waitForAvailableAfterModify(
  this: RDSDBProxyProvider,
  physicalId: string,
  resourceType: string,
  logicalId: string,
  mask: (s: string) => string
): Promise<void> {
  const client = this.getClient();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status: string | undefined;
  while (Date.now() < deadline) {
    try {
      const describe = await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
      const proxy = describe.DBProxies?.[0];
      // No proxy is the same answer DBProxyNotFoundFault gives below: fail
      // now instead of waiting out the deadline.
      if (!proxy) {
        throw new ProvisioningError(
          mask(`DBProxy ${physicalId} was not found while waiting for it after modify`),
          resourceType,
          logicalId,
          physicalId
        );
      }
      status = proxy.Status;
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw this.wrapCaughtError(error, 'UPDATE (poll)', resourceType, logicalId, physicalId, mask);
    }
    if (status === 'available') return;
    if (status === 'incompatible-network' || status === 'insufficient-resource-limits') {
      throw new ProvisioningError(
        mask(`DBProxy ${physicalId} entered terminal failure state after modify: ${status}`),
        resourceType,
        logicalId,
        physicalId
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new ProvisioningError(
    mask(
      `Timed out waiting for DBProxy ${physicalId} to become available after modify (last status: ${status ?? 'unknown'})`
    ),
    resourceType,
    logicalId,
    physicalId
  );
}

/**
 * Issue #1160: one warning naming each {@link RETAINED_ON_REMOVAL} property
 * the template dropped ({@link removedRetained}).
 */
export function warnOnRetainedRemovals(
  this: RDSDBProxyProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): void {
  const retained = this.removedRetained(properties, previousProperties, context);
  if (retained.length === 0) return;
  const one = retained.length === 1;
  const names = `${one ? 'property' : 'properties'} ${retained.join(', ')}`;
  // The CloudFormation claim only when CloudFormation is measured to keep
  // EVERY named property (CFN_KEEPS_ON_REMOVAL).
  this.logger.warn(
    context?.replayingState === true
      ? safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'is' : 'are'} absent from the state being restored; ModifyDBProxy keeps a setting it is not sent, so the rollback leaves any value the failed deploy applied in place.`
      : retained.every((key) => CFN_KEEPS_ON_REMOVAL.has(key))
        ? safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'was' : 'were'} removed from the template and ${one ? 'keeps its' : 'keep their'} current AWS value, as CloudFormation leaves ${one ? 'it' : 'them'}; ModifyDBProxy keeps a setting it is not sent. Declare the property with the value you want to change it.`
        : safeMsg`${logicalId} (${resourceType}): ${names} ${one ? 'was' : 'were'} removed from the template; ModifyDBProxy keeps a setting it is not sent, so the proxy keeps its current value. Declare the property with the value you want to change it.`
  );
}

/**
 * The {@link RETAINED_ON_REMOVAL} properties the template dropped. The
 * removed set is the caller's (template against template, EMPTY on
 * `drift --revert`, whose previous side is a readback); a direct call
 * applies the same presence test (`removedTemplateKeys`).
 */
export function removedRetained(
  this: RDSDBProxyProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined
): string[] {
  const removed = context?.removedProperties;
  const retained: string[] = [];
  for (const key of RETAINED_ON_REMOVAL) {
    const isRemoved =
      removed !== undefined
        ? removed.has(key)
        : previousProperties[key] !== undefined && properties[key] === undefined;
    if (isRemoved) retained.push(key);
  }
  return retained;
}

export async function applyTagDiff(
  this: RDSDBProxyProvider,
  physicalId: string,
  oldTags: unknown,
  newTags: unknown,
  resourceType: string,
  logicalId: string,
  // The physical id is a name that can be secret-derived (go-to-k/cdkd#4275).
  maskSecrets?: MaskerFn
): Promise<void> {
  // Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
  // unreadable record untags nothing.
  const plan = planTagDiff(oldTags, newTags, DBPROXY_TAG_OPTIONS);

  // Tag-map equality short-circuit BEFORE the ARN-lookup Describe — skips
  // the wasted Describe when no tag diff exists (PR #400 review M1).
  // Warned before the short-circuit, so a hidden recorded key is reported
  // without the ARN Describe, and a missing ARN cannot swallow the warning.
  const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
  if (tagWarning !== undefined) {
    this.logger.warn(tagWarning);
  }
  if (plan.set.size === 0 && plan.remove.length === 0) return;

  const client = this.getClient();

  // The SAME key `getAttribute` builds for this attribute, so the two share
  // ONE cache entry. Spelling it a second way here is what go-to-k/cdkd#3496's
  // first cut did: the key moved and this reader did not, leaving two copies
  // of one ARN in one Map and an extra Describe per update.
  const arnCacheKey = injectiveKey(physicalId, 'DBProxyArn');
  let arn = this.attributeCache.get(arnCacheKey) as string | undefined;
  if (!arn) {
    try {
      const describe = await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
      arn = describe.DBProxies?.[0]?.DBProxyArn;
      if (arn) this.attributeCache.set(arnCacheKey, arn);
    } catch (error) {
      // Can't tag without an ARN — log + skip.
      this.logger.debug(
        maskerOrIdentity(maskSecrets)(
          `Skipping tag diff for ${maskerOrIdentity(maskSecrets)(physicalId)} (no ARN): ${describeAwsFailure(error).detail}`
        )
      );
      return;
    }
  }
  if (!arn) return;

  const toRemove = plan.remove;
  const toAdd: Tag[] = [...plan.set].map(([Key, Value]) => ({ Key, Value }));

  if (toRemove.length > 0) {
    try {
      await client.send(
        new RemoveTagsFromResourceCommand({ ResourceName: arn, TagKeys: toRemove })
      );
    } catch (error) {
      throw this.wrapCaughtError(
        error,
        'UPDATE (remove tags)',
        resourceType,
        logicalId,
        physicalId,
        maskerOrIdentity(maskSecrets)
      );
    }
  }
  if (toAdd.length > 0) {
    try {
      await client.send(new AddTagsToResourceCommand({ ResourceName: arn, Tags: toAdd }));
    } catch (error) {
      throw this.wrapCaughtError(
        error,
        'UPDATE (add tags)',
        resourceType,
        logicalId,
        physicalId,
        maskerOrIdentity(maskSecrets)
      );
    }
  }
}
