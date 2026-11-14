import {
  TagResourceCommand,
  UntagResourceCommand,
  CreateServiceCommand,
  type CreateServiceCommandOutput,
  UpdateServiceCommand,
  DeleteServiceCommand,
  UpdateServiceAttributesCommand,
  DeleteServiceAttributesCommand,
  GetServiceCommand,
  NamespaceNotFound,
  ServiceNotFound,
  type DnsConfig,
  type DnsConfigChange,
  type HealthCheckCustomConfig,
  type HealthCheckConfig,
  type ServiceChange,
  type Tag,
  type ServiceTypeOption,
} from '@aws-sdk/client-servicediscovery';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { withRetry } from '../../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { generatedNameFor } from '../../resource-name.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../../tag-list.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  SecretMasker,
} from '../../../types/resource.js';
import { definedAttributes } from '../../attribute-map.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import type { ServiceDiscoveryProvider } from '../servicediscovery-provider.js';
import {
  CREATE_SERVICE_NAMESPACE_LAG_MAX_RETRIES,
  CREATE_SERVICE_NAMESPACE_LAG_INITIAL_DELAY_MS,
  CREATE_SERVICE_NAMESPACE_LAG_MAX_DELAY_MS,
  CREATE_SERVICE_NAMESPACE_LAG_BACKOFF_SECONDS,
  sameAsRecorded,
  unappliedDnsConfigMembers,
  markNotGoneOnNotFoundClass,
} from './shared.js';

// ─── AWS::ServiceDiscovery::Service ───────────────────────────────

export async function createService(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating service discovery service ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const client = this.getClient();

  // go-to-k/cdkd#5348: the name is optional, as in CloudFormation, which
  // generates one; so does cdkd, through the shared rule.
  const name =
    (properties['Name'] as string | undefined) ||
    generatedNameFor('AWS::ServiceDiscovery::Service', logicalId);
  const namespaceId = properties['NamespaceId'] as string | undefined;
  const description = properties['Description'] as string | undefined;
  const dnsConfig = properties['DnsConfig'] as DnsConfig | undefined;
  const healthCheckCustomConfig = properties['HealthCheckCustomConfig'] as
    | HealthCheckCustomConfig
    | undefined;
  const healthCheckConfig = properties['HealthCheckConfig'] as HealthCheckConfig | undefined;
  const type = properties['Type'] as ServiceTypeOption | undefined;

  let leftBehindServiceId: string | undefined;
  try {
    // Issue #5113: right after its namespace's create operation reports
    // SUCCESS, Cloud Map can still answer `NamespaceNotFound` (a
    // read-after-write lag, observed live on the servicediscovery fixture:
    // one of four parallel creates against a fresh namespace). Retry THAT
    // error only, for ~27.5s of backoff; every other error surfaces at once.
    //
    // A retry cannot duplicate the service: `NamespaceNotFound` is a
    // synchronous client-fault rejection, so no service exists after it,
    // and only that error is retried. Each attempt carries its own
    // `CreatorRequestId` — cdkd sends none, and the SDK mints a fresh
    // idempotency token per `send` — so a retry is never matched against
    // the rejected attempt's token.
    //
    // Interruptible (issue #2053), and through the masked sink (issue
    // #2050): `withRetry` prints AWS's message, which quotes the RESOLVED
    // `NamespaceId` back.
    const watch = startInterruptWatch(`Cloud Map service ${logicalId}`);
    let response: CreateServiceCommandOutput;
    try {
      response = await withRetry(
        () =>
          client.send(
            new CreateServiceCommand({
              Name: name,
              ...(namespaceId && { NamespaceId: namespaceId }),
              ...(description && { Description: description }),
              ...(dnsConfig && { DnsConfig: dnsConfig }),
              ...(healthCheckCustomConfig && {
                HealthCheckCustomConfig: healthCheckCustomConfig,
              }),
              ...(healthCheckConfig && { HealthCheckConfig: healthCheckConfig }),
              ...(tags.length > 0 && { Tags: tags }),
              ...(type && { Type: type }),
            })
          ),
        logicalId,
        {
          maxRetries: CREATE_SERVICE_NAMESPACE_LAG_MAX_RETRIES,
          initialDelayMs: CREATE_SERVICE_NAMESPACE_LAG_INITIAL_DELAY_MS,
          maxDelayMs: CREATE_SERVICE_NAMESPACE_LAG_MAX_DELAY_MS,
          isRetryable: (_text, error) => error instanceof NamespaceNotFound,
          logger: this.maskedRetryLogger(maskSecrets),
          isInterrupted: watch.isInterrupted,
          onInterrupted: watch.onInterrupted,
        }
      );
    } finally {
      watch.dispose();
    }

    const service = response.Service;
    if (!service || !service.Id) {
      throw new Error('CreateService did not return Service ID');
    }
    const serviceId = service.Id;
    // go-to-k/cdkd#4583: AWS holds this service; cleared once the cleanup deletes it.
    leftBehindServiceId = serviceId;
    reportCreatedResource(logicalId, resourceType, serviceId);

    this.logger.debug(`Successfully created service discovery service ${logicalId}: ${serviceId}`);

    // ServiceAttributes is NOT accepted by CreateService — it rides on a
    // separate post-create `UpdateServiceAttributes` control-plane call.
    // CreateService has already committed the service on AWS, so a failure
    // here would strand a half-configured service that the next deploy plans
    // CREATE for (and AWS then rejects with a name collision). Wrap the
    // attributes call in an inner try/catch that issues a best-effort
    // `DeleteService` before re-throwing (atomicity), mirroring the ELBv2
    // Listener create path (PR #879).
    try {
      const attrs = this.normalizeServiceAttributes(properties['ServiceAttributes']);
      if (Object.keys(attrs).length > 0) {
        // Interruptible (issue #2053).
        const watch = startInterruptWatch(`Cloud Map service ${logicalId} attributes`);
        try {
          await withRetry(
            () =>
              client.send(
                new UpdateServiceAttributesCommand({ ServiceId: serviceId, Attributes: attrs })
              ),
            logicalId,
            // NOT `this.logger` (issue #2050): `attrs` is
            // `properties['ServiceAttributes']`, already RESOLVED, and an AWS
            // rejection quotes the offending value back into the message
            // `withRetry` interpolates.
            {
              logger: this.maskedRetryLogger(maskSecrets),
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
            }
          );
        } finally {
          watch.dispose();
        }
        this.logger.debug(
          `Applied ${Object.keys(attrs).length} ServiceAttribute(s) for ${logicalId}`
        );
      }
    } catch (innerError) {
      // An interrupt takes the SAME cleanup as any other attributes-wiring
      // failure — see the twin arm in `elbv2-provider.ts` for the full
      // argument. In short: `create()` is throwing, so nothing in cdkd state
      // ever holds this service id (only a FAILED cleanup marks it for the
      // rollback journal, go-to-k/cdkd#4583), and the choice is "delete vs
      // orphan" rather than "delete vs preserve".
      //
      // The Cloud Map case is the WORSE of the two, which is why the note is
      // not simply a cross-reference: an orphaned service also blocks
      // `DeleteServiceDiscoveryNamespace` with `ResourceInUse`, so the
      // untracked leftover makes the enclosing NAMESPACE undestroyable too.
      //
      // The handle is printed BEFORE the delete is attempted, at default
      // verbosity, so a process that dies mid-cleanup still leaves the user
      // something to act on.
      if (isInterruptedWaitError(innerError)) {
        // Masked for the same reason as the sibling `warn` below, which
        // states it: an unmasked line sitting beside masked ones is what a
        // later author copies.
        this.logger.warn(
          maskerOrIdentity(maskSecrets)(
            `Interrupted after creating ServiceDiscovery Service ${logicalId} (${serviceId}) ` +
              `but before its ServiceAttributes were applied. Nothing in cdkd state refers to ` +
              `it, so cdkd is deleting it now — left behind it would fail the next deploy on a ` +
              `name collision AND block deletion of its namespace with ResourceInUse. If that ` +
              `delete fails, outside a rollback's re-create, the failed deploy's rollback journal records it for ${proseQuoted(cdkdRemedy('cdkd rollback', '--revert-failed'), '`')}; otherwise remove it yourself: ` +
              `${pasteableAwsCommand(maskSecrets)`aws servicediscovery delete-service --id ${serviceId}`.render()}`
          )
        );
      }
      try {
        await client.send(new DeleteServiceCommand({ Id: serviceId }));
        leftBehindServiceId = undefined;
        retractCreatedResource(logicalId, resourceType, serviceId);
        this.logger.debug(
          `Cleaned up partially-created ServiceDiscovery Service ${logicalId} (${serviceId}) after ServiceAttributes wiring failure`
        );
      } catch (cleanupError) {
        // An AWS failure is named by its class at warn, AWS's text at debug
        // under the same head (go-to-k/cdkd#2319): a denied `DeleteService`
        // names the caller. A cdkd-authored error keeps its text at warn.
        const cleanupFailure = describeAwsFailure(cleanupError);
        const cleanupHead =
          `Failed to clean up partially-created ServiceDiscovery Service ${logicalId} ` +
          `(${serviceId}) after ServiceAttributes wiring failure: `;
        if (cleanupFailure.redacted) {
          this.logger.debug(
            maskerOrIdentity(maskSecrets)(`${cleanupHead}${cleanupFailure.detail}`)
          );
        }
        this.logger.warn(
          // Masked for uniformity with the sibling lines in this same `try`
          // (issue #2050). The cleanup call carries only a physical id, so a
          // resolved property value reaching here would be surprising — but
          // "surprising" is not "impossible", and an unmasked line sitting
          // beside masked ones is what a later author copies.
          `${cleanupHead}` +
            `${cleanupFailure.redacted ? `${maskerOrIdentity(maskSecrets)(cleanupFailure.summary)} ` : `${this.maskErrorMessage(cleanupError, maskSecrets)}. `}Outside a rollback's re-create, the failed deploy's rollback ` +
            `journal records it for ${proseQuoted(cdkdRemedy('cdkd rollback', '--revert-failed'), '`')}; otherwise delete it yourself ` +
            `before the next deploy: ` +
            `${pasteableAwsCommand(maskSecrets)`aws servicediscovery delete-service --id ${serviceId}`.render()}`
        );
      }
      // The service itself was created: an "already exists" from its
      // attributes wiring is not this service's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    return {
      physicalId: serviceId,
      attributes: definedAttributes({
        Id: serviceId,
        Arn: service.Arn,
        Name: service.Name || name,
      }),
    };
  } catch (error) {
    // `cause` carries the ORIGINAL error untouched (issue #2050): the
    // classifier walks it for `$metadata`, so only the human-readable
    // message is masked.
    const cause = error instanceof Error ? error : undefined;
    // Issue #5113: the retry above gives up silently at default verbosity
    // (its custom classifier feeds none of `withRetry`'s give-up counters),
    // so the wrap says the wait happened. Worded with no not-found phrase,
    // which the substring classifiers would read.
    const retriedNote =
      error instanceof NamespaceNotFound
        ? ` (Cloud Map still rejected the namespace after ${CREATE_SERVICE_NAMESPACE_LAG_BACKOFF_SECONDS}s of retries)`
        : '';
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create service discovery service ${logicalId}${retriedNote}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (leftBehindServiceId) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindServiceId);
    }
    throw thrown;
  }
}

/**
 * Update a service discovery service.
 *
 * Per AWS docs, `UpdateService` accepts a `ServiceChange` body with
 * `Description`, `DnsConfig.DnsRecords` (TTLs etc. — `DnsConfig.NamespaceId`
 * / `RoutingPolicy` are not part of the change shape: a change to either is
 * not applied, as in CloudFormation, and is named in a warning; see
 * {@link unappliedDnsConfigMembers}), and `HealthCheckConfig`. `Name` /
 * `NamespaceId` /
 * `HealthCheckCustomConfig` are immutable on UpdateService — the
 * replacement-detection layer routes those through DELETE+CREATE.
 *
 * The `ServiceChange` body REPLACES rather than merges: an omitted
 * `Description` or `HealthCheckConfig` is cleared, and an omitted
 * `DnsConfig` is refused on a DNS service (`Service dns config cannot be
 * null`). WHEN to send it, and with what, follows CloudFormation
 * ({@link planServiceChange}, issue #1160). `cdkd drift --revert` passes
 * the full AWS-current snapshot as both bags with the drifted keys
 * overlaid, so only a drifted field reads as a change.
 */
export async function updateService(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  maskSecrets?: SecretMasker,
  changedProperties?: ReadonlySet<string>
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating service discovery service ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: `Tags` used to be ignored on update; a malformed
  // desired one is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const client = this.getClient();

  const servicePlan = this.planServiceChange(properties, previousProperties, changedProperties);
  const serviceChange = servicePlan?.change ?? {};

  // ServiceAttributes is NOT part of the `ServiceChange` body — it is
  // mutated via its own `UpdateServiceAttributes` (upsert) /
  // `DeleteServiceAttributes` (remove keys) APIs. Diff old vs new: keys
  // whose value changed or are new go in the upsert map; keys present only
  // in the old set are removed. These calls THROW on AWS failure (NOT
  // warn-swallow) so cdkd state is never written as-if-applied — see memory
  // feedback_tags_on_update_must_throw; the next deploy retries naturally.
  const newAttrs = this.normalizeServiceAttributes(properties['ServiceAttributes']);
  const oldAttrs = this.normalizeServiceAttributes(previousProperties['ServiceAttributes']);
  const upsertAttrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(newAttrs)) {
    if (oldAttrs[k] !== v) upsertAttrs[k] = v;
  }
  const removedAttrKeys = Object.keys(oldAttrs).filter((k) => !Object.hasOwn(newAttrs, k));

  const hasServiceChange = servicePlan !== undefined;
  const hasAttrUpsert = Object.keys(upsertAttrs).length > 0;
  const hasAttrRemove = removedAttrKeys.length > 0;

  // Tags ride their own TagResource / UntagResource calls, keyed by the
  // service ARN (go-to-k/cdkd#3994).
  const tagPlan = planTagDiff(previousProperties['Tags'], properties['Tags']);
  const hasTagChange = tagPlan.set.size > 0 || tagPlan.remove.length > 0;
  // Warned whatever else the update does: a record cdkd cannot read, or keys
  // it cannot name, matter even when the plan has nothing to send.
  const tagWarning = tagPlanWarning(tagPlan, resourceType, logicalId);
  if (tagWarning !== undefined) this.logger.warn(tagWarning);

  // go-to-k/cdkd#5373: named once the update has succeeded (or had nothing
  // to send), never before a call that could still fail.
  const unapplied = unappliedDnsConfigMembers(properties, previousProperties, changedProperties);

  if (!hasServiceChange && !hasAttrUpsert && !hasAttrRemove && !hasTagChange) {
    this.logger.debug(`No mutable diff for ServiceDiscovery Service ${logicalId}, skipping update`);
    await this.warnUnappliedDnsConfigMembers(logicalId, physicalId, properties, unapplied);
    return { physicalId, wasReplaced: false };
  }

  // The service's ARN when a GetService already ran in this update, so the
  // Tags arm below does not read it a second time.
  let knownArn: string | undefined;
  try {
    if (hasServiceChange) {
      if (servicePlan.keepRemovedFromLive) {
        knownArn = await this.keepUndeclaredServiceFields(physicalId, serviceChange);
      }
      const response = await client.send(
        new UpdateServiceCommand({
          Id: physicalId,
          Service: serviceChange,
        })
      );

      const operationId = response.OperationId;
      if (operationId) {
        // Threaded (issue #2063): the `UpdateService` body carries the
        // resolved `Description` / `DnsConfig` / `HealthCheckConfig`, and
        // this arm's catch re-throws a `ProvisioningError` untouched — so
        // the operation's `ErrorMessage` escapes unless `pollOperation`
        // masks it itself. Issue #2050 threaded the two `withRetry` calls
        // below but left this one, which was the hole.
        await this.pollOperation(operationId, logicalId, resourceType, maskSecrets);
      }
    }

    // ONE watch for both attribute calls (issue #2053): they run back to back
    // on the same resource, so a single Ctrl-C has to abort whichever of them
    // is currently in its backoff.
    // Entered only when an attribute call actually runs (issue #2053 review):
    // the common update touches no ServiceAttributes at all, and a watch taken
    // for it is a `Set` entry added and removed for a path that never waits.
    if (hasAttrUpsert || hasAttrRemove) {
      const attrWatch = startInterruptWatch(`Cloud Map service ${logicalId} attributes`);
      try {
        if (hasAttrUpsert) {
          await withRetry(
            () =>
              client.send(
                new UpdateServiceAttributesCommand({
                  ServiceId: physicalId,
                  Attributes: upsertAttrs,
                })
              ),
            logicalId,
            // Masked for the same reason as the create path (issue #2050) — the
            // upsert map is built from `properties`, already RESOLVED.
            {
              logger: this.maskedRetryLogger(maskSecrets),
              isInterrupted: attrWatch.isInterrupted,
              onInterrupted: attrWatch.onInterrupted,
            }
          );
          this.logger.debug(
            `Applied ${Object.keys(upsertAttrs).length} ServiceAttribute change(s) for ${logicalId}`
          );
        }

        if (hasAttrRemove) {
          await withRetry(
            () =>
              client.send(
                new DeleteServiceAttributesCommand({
                  ServiceId: physicalId,
                  Attributes: removedAttrKeys,
                })
              ),
            logicalId,
            // Masked too (issue #2050). The payload is attribute KEYS from
            // `previousProperties`, not values — but a key can itself be a
            // resolved secret, and AWS quotes the rejected key back.
            {
              logger: this.maskedRetryLogger(maskSecrets),
              isInterrupted: attrWatch.isInterrupted,
              onInterrupted: attrWatch.onInterrupted,
            }
          );
          this.logger.debug(
            `Removed ${removedAttrKeys.length} ServiceAttribute(s) for ${logicalId}`
          );
        }
      } finally {
        attrWatch.dispose();
      }
    }

    if (hasTagChange) {
      const arn =
        knownArn ?? (await client.send(new GetServiceCommand({ Id: physicalId }))).Service?.Arn;
      if (!arn) {
        throw new ProvisioningError(
          safeMsg`Could not resolve the ARN of service discovery service ${logicalId}; its Tags were not updated`,
          resourceType,
          logicalId,
          physicalId
        );
      }
      if (tagPlan.remove.length > 0) {
        await client.send(new UntagResourceCommand({ ResourceARN: arn, TagKeys: tagPlan.remove }));
      }
      if (tagPlan.set.size > 0) {
        await client.send(
          new TagResourceCommand({
            ResourceARN: arn,
            Tags: [...tagPlan.set].map(([Key, Value]) => ({ Key, Value })),
          })
        );
      }
    }

    this.logger.debug(`Successfully updated service discovery service ${logicalId}`);
    await this.warnUnappliedDnsConfigMembers(logicalId, physicalId, properties, unapplied);

    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    // `cause` carries the ORIGINAL error untouched (issue #2050) — see the
    // create path above.
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update service discovery service ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Decide whether `UpdateService` is sent and what it carries, following
 * CloudFormation (issue #1160; live A/Bs in us-east-1, go-to-k/cdkd#1160
 * issuecomment-6272137682 and issuecomment-6281592365):
 *
 * - A DECLARED `Description` or `HealthCheckConfig` differing from the
 *   previous template: CloudFormation sends the declared model as it is, so
 *   a removed `Description` / `HealthCheckConfig` in the same update is
 *   CLEARED and a removed `DnsConfig` is REFUSED by AWS (`Service dns
 *   config cannot be null`). cdkd sends the same body.
 * - Only `DnsConfig.DnsRecords` differing (a TTL, say): CloudFormation
 *   sends nothing, so the record change is DROPPED and any removed field is
 *   kept. cdkd DIVERGES deliberately and applies the record change, but
 *   keeps a removed `Description` / `HealthCheckConfig` from the live
 *   service ({@link keepUndeclaredServiceFields}), so their final state
 *   still matches CloudFormation.
 * - Nothing declared differing (a removal on its own, or a change only to
 *   `ServiceAttributes` / `Tags`): no `UpdateService`, every removed field
 *   is kept — as CloudFormation.
 *
 * Returns `undefined` when no `UpdateService` is due.
 */
export function planServiceChange(
  this: ServiceDiscoveryProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  changedProperties: ReadonlySet<string> | undefined
): { change: ServiceChange; keepRemovedFromLive: boolean } | undefined {
  // go-to-k/cdkd#5112: the engine's template-to-template answer when it gave
  // one; otherwise (a rollback revert, `drift --revert`, a direct call) the
  // two bags compared here, a recorded stand-in counting as changed.
  const changed = (key: string): boolean =>
    changedProperties !== undefined
      ? changedProperties.has(key)
      : !sameAsRecorded(properties[key], previousProperties[key]);
  const declaredDiffers = (key: string): boolean => properties[key] !== undefined && changed(key);

  const change: ServiceChange = {};
  if (properties['Description'] !== undefined) {
    change.Description = properties['Description'] as string;
  }
  const desiredRecords = (properties['DnsConfig'] as DnsConfig | undefined)?.DnsRecords;
  const previousRecords = (previousProperties['DnsConfig'] as DnsConfig | undefined)?.DnsRecords;
  if (desiredRecords !== undefined) {
    const dnsChange: DnsConfigChange = { DnsRecords: desiredRecords };
    change.DnsConfig = dnsChange;
  }
  if (properties['HealthCheckConfig'] !== undefined) {
    change.HealthCheckConfig = properties['HealthCheckConfig'] as HealthCheckConfig;
  }

  if (declaredDiffers('Description') || declaredDiffers('HealthCheckConfig')) {
    return { change, keepRemovedFromLive: false };
  }
  // `DnsConfig` unchanged as written leaves its records unchanged; changed,
  // the records themselves are compared (its other members cannot be
  // updated; go-to-k/cdkd#5373).
  if (
    desiredRecords !== undefined &&
    (changedProperties === undefined || changedProperties.has('DnsConfig')) &&
    !sameAsRecorded(desiredRecords, previousRecords)
  ) {
    return { change, keepRemovedFromLive: true };
  }
  return undefined;
}

/**
 * Name each `DnsConfig` member {@link unappliedDnsConfigMembers} found, in
 * one warning (go-to-k/cdkd#5373), once the live service confirms it still
 * differs. The state records the declared value, never applied, so a
 * template-to-state difference alone also fires on a rollback revert, on a
 * template reverted to what AWS holds, and on a member added at the value
 * AWS already has. A failed read keeps the warning: it cannot be confirmed
 * either way, and the update itself has already succeeded.
 */
export async function warnUnappliedDnsConfigMembers(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  properties: Record<string, unknown>,
  candidates: readonly string[]
): Promise<void> {
  if (candidates.length === 0) return;
  let members = candidates;
  try {
    const live = (await this.getClient().send(new GetServiceCommand({ Id: physicalId }))).Service;
    const dns = properties['DnsConfig'] as DnsConfig;
    const desired: Record<string, unknown> = {
      NamespaceId: dns.NamespaceId ?? properties['NamespaceId'],
      RoutingPolicy: dns.RoutingPolicy,
    };
    const held: Record<string, unknown> = {
      NamespaceId: live?.NamespaceId ?? live?.DnsConfig?.NamespaceId,
      RoutingPolicy: live?.DnsConfig?.RoutingPolicy,
    };
    members = candidates.filter((m) => desired[m] === undefined || desired[m] !== held[m]);
  } catch {
    this.logger.debug(
      safeMsg`Could not read service discovery service ${logicalId} back to confirm its DnsConfig; warning unconfirmed`
    );
  }
  if (members.length === 0) return;
  const paths = members.map((m) => `DnsConfig.${m}`).join(' and ');
  const [it, value] = members.length > 1 ? ['them', 'values'] : ['it', 'value'];
  const remedy = members.includes('NamespaceId')
    ? 'To move the service, declare the namespace in the top-level NamespaceId: a change there replaces the service.'
    : 'To change it, replace the service, for example by giving it a new Name.';
  this.logger.warn(
    safeMsg`${logicalId} (AWS::ServiceDiscovery::Service): ${paths} changed, but Cloud Map cannot change ${it} on an existing service, so the service keeps its current ${value}, as CloudFormation does. ${remedy}`
  );
}

/**
 * The DnsRecords-only arm of {@link planServiceChange}: fill a
 * `Description` / `HealthCheckConfig` the template does not declare with
 * the service's live value, so the replace-style `UpdateService` keeps it,
 * as CloudFormation (which sends nothing there) does. Returns the service
 * ARN when it read one.
 */
export async function keepUndeclaredServiceFields(
  this: ServiceDiscoveryProvider,
  physicalId: string,
  serviceChange: ServiceChange
): Promise<string | undefined> {
  if (serviceChange.Description !== undefined && serviceChange.HealthCheckConfig !== undefined) {
    return undefined;
  }
  const live = (await this.getClient().send(new GetServiceCommand({ Id: physicalId }))).Service;
  if (serviceChange.Description === undefined && live?.Description !== undefined) {
    serviceChange.Description = live.Description;
  }
  if (serviceChange.HealthCheckConfig === undefined && live?.HealthCheckConfig !== undefined) {
    serviceChange.HealthCheckConfig = live.HealthCheckConfig;
  }
  return live?.Arn;
}

export async function deleteService(
  this: ServiceDiscoveryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting service discovery service ${logicalId}: ${physicalId}`);
  const client = this.getClient();

  try {
    await client.send(new DeleteServiceCommand({ Id: physicalId }));
    this.logger.debug(`Successfully deleted service discovery service ${logicalId}`);
  } catch (error) {
    if (error instanceof ServiceNotFound) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Service ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const refused = markNotGoneOnNotFoundClass(
      error,
      this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete service discovery service ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      )
    );
    throw refused;
  }
}
