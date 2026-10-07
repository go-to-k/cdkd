import {
  RDSClient,
  CreateDBProxyEndpointCommand,
  ModifyDBProxyEndpointCommand,
  DeleteDBProxyEndpointCommand,
  DescribeDBProxyEndpointsCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  DBProxyEndpointNotFoundFault,
  DBProxyNotFoundFault,
  type DBProxyEndpointTargetRole,
  type Tag,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import {
  planTagDiff,
  tagPlanWarning,
  refuseMalformedDesiredTags,
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
} from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { definedAttributes } from '../attribute-map.js';
import { unchangedBehindSecretReference } from '../secret-reference-immutable.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  withDerivedNameMasks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { injectiveKey, injectiveKeyPrefix } from '../../state/record-keys.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * AWS RDS DBProxyEndpoint Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxyEndpoint` — the
 * additional read/write or read-only endpoint that can be attached to a
 * parent DBProxy.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * completes the RDS DBProxy family started in PR #387 (`DBProxyTargetGroup`)
 * and PR #394 (`DBProxy`). Keeps the whole family on one codebase so create /
 * update / delete handling stays consistent across the parent + endpoints +
 * target-group children.
 *
 * **Lifecycle**:
 * - `create`: validates required fields (`DBProxyName` / `VpcSubnetIds`),
 *   issues `CreateDBProxyEndpointCommand`, then polls `DescribeDBProxyEndpoints`
 *   until `Status === 'available'`. Returns `physicalId = DBProxyEndpointName`
 *   plus `Endpoint` / `DBProxyEndpointArn` / `IsDefault` / `VpcId` in
 *   `attributes`.
 * - `update`: `ModifyDBProxyEndpointCommand` for the mutable fields
 *   (`VpcSecurityGroupIds` → SDK input `VpcSecurityGroupIds`,
 *   `NewDBProxyEndpointName` via rename). Tags diff via separate
 *   `AddTagsToResource` / `RemoveTagsFromResource` calls. DBProxyName /
 *   VpcSubnetIds / TargetRole are immutable on AWS.
 * - `delete`: `DeleteDBProxyEndpointCommand`, then polls until
 *   `DBProxyEndpointNotFoundFault`. Idempotent on NotFound (region-match
 *   gated). `DBProxyNotFoundFault` also idempotent — if the parent DBProxy
 *   is already gone via CASCADE, the endpoint is too.
 * - `getAttribute`: `Endpoint` / `DBProxyEndpointArn` / `IsDefault` / `VpcId`
 *   via `DescribeDBProxyEndpoints`, cached per `(physicalId, attribute)`.
 * - `import`: explicit `--resource <id>=<DBProxyEndpointName>` or the
 *   template's `DBProxyEndpointName` property (issue #1134 removed the
 *   unreachable `aws:cdk:path` tag walk).
 *
 * **physicalId** = DBProxyEndpointName (matches CFn `primaryIdentifier`).
 */
export class RDSDBProxyEndpointProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private createClient?: RDSClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('RDSDBProxyEndpointProvider');
  private readonly attributeCache = new Map<string, unknown>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxyEndpoint',
      new Set([
        'DBProxyEndpointName',
        'DBProxyName',
        'VpcSubnetIds',
        'VpcSecurityGroupIds',
        'TargetRole',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.rdsClient = new RDSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new RDSClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.rdsClient;
  }

  /**
   * The client `CreateDBProxyEndpoint` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateDBProxyEndpoint` carries no idempotency token and the proxy endpoint name is unique per
   * account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with what the first send made, and that "already
   * exists" surfaced from the engine's FIRST attempt as a name somebody else
   * holds. Refused here, the 5xx reaches the deploy engine's retry, which
   * marks the create as possibly replayed (`withRetry`, #3978). Nothing is
   * adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): RDSClient {
    this.getClient();
    return this.createClient as RDSClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const tags = refuseMalformedDesiredTags(
      properties['Tags'],
      resourceType,
      logicalId,
      undefined,
      'Tags',
      DBPROXY_TAGS_WHAT,
      DBPROXY_TAG_OPTIONS
    );
    const dbProxyName = properties['DBProxyName'] as string | undefined;
    if (!dbProxyName) {
      throw new ProvisioningError(
        `DBProxyName is required for AWS::RDS::DBProxyEndpoint ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const dbProxyEndpointName =
      (properties['DBProxyEndpointName'] as string | undefined) ??
      generateResourceName(logicalId, { maxLength: 64 });
    const vpcSubnetIds = properties['VpcSubnetIds'] as string[] | undefined;
    if (!vpcSubnetIds || vpcSubnetIds.length === 0) {
      throw new ProvisioningError(
        `VpcSubnetIds (at least one) is required for AWS::RDS::DBProxyEndpoint ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const client = this.getClient();
    this.logger.debug(`Creating DBProxyEndpoint ${dbProxyEndpointName} (proxy=${dbProxyName})`);

    try {
      await this.getCreateClient().send(
        new CreateDBProxyEndpointCommand({
          DBProxyName: dbProxyName,
          DBProxyEndpointName: dbProxyEndpointName,
          VpcSubnetIds: vpcSubnetIds,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          TargetRole: properties['TargetRole'] as DBProxyEndpointTargetRole | undefined,
          Tags: tags.length > 0 ? tags : undefined,
        })
      );
    } catch (error) {
      throw this.wrapError(error, 'CREATE', resourceType, logicalId, undefined);
    }

    let endpoint: string | undefined;
    let arn: string | undefined;
    let isDefault: boolean | undefined;
    let vpcId: string | undefined;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let status: string | undefined;
    try {
      while (Date.now() < deadline) {
        try {
          // NOTE: filter by DBProxyEndpointName only — passing both
          // `DBProxyName` AND `DBProxyEndpointName` returned an empty array
          // during the create poll on real AWS (eventual-consistency-window
          // bug observed 2026-05-16 rds-aurora integ). The endpoint name is
          // already a unique identifier per region.
          const describe = await client.send(
            new DescribeDBProxyEndpointsCommand({
              DBProxyEndpointName: dbProxyEndpointName,
            })
          );
          const ep = describe.DBProxyEndpoints?.[0];
          status = ep?.Status;
          this.logger.debug(
            `DBProxyEndpoint ${dbProxyEndpointName} poll: status=${status ?? 'not-yet-visible'}`
          );
          if (status === 'available') {
            endpoint = ep?.Endpoint;
            arn = ep?.DBProxyEndpointArn;
            isDefault = ep?.IsDefault;
            vpcId = ep?.VpcId;
            break;
          }
          if (status === 'incompatible-network' || status === 'insufficient-resource-limits') {
            throw new ProvisioningError(
              `DBProxyEndpoint ${dbProxyEndpointName} entered terminal failure state: ${status}`,
              resourceType,
              logicalId,
              dbProxyEndpointName
            );
          }
        } catch (error) {
          if (
            error instanceof DBProxyEndpointNotFoundFault ||
            error instanceof DBProxyNotFoundFault
          ) {
            // Not yet visible — keep polling.
          } else if (error instanceof ProvisioningError) {
            throw error;
          } else {
            throw this.wrapError(
              error,
              'CREATE (poll)',
              resourceType,
              logicalId,
              dbProxyEndpointName
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (!endpoint || !arn) {
        throw new ProvisioningError(
          `Timed out waiting for DBProxyEndpoint ${dbProxyEndpointName} to become available (last status: ${status ?? 'unknown'})`,
          resourceType,
          logicalId,
          dbProxyEndpointName
        );
      }
    } catch (error) {
      // go-to-k/cdkd#4583: CreateDBProxyEndpoint returned, so the endpoint
      // exists under `dbProxyEndpointName` (the id delete() takes); name it
      // for --revert-failed.
      markCreatedBeforeFailure(error, logicalId, resourceType, dbProxyEndpointName);
      throw error;
    }

    return {
      physicalId: dbProxyEndpointName,
      attributes: definedAttributes({
        Endpoint: endpoint,
        DBProxyEndpointArn: arn,
        IsDefault: isDefault ?? false,
        VpcId: vpcId,
      }),
    };
  }

  async update(
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
    const client = this.getClient();
    // The physical id IS the endpoint name, which can be secret-derived. Paired
    // with the RECORDED name (go-to-k/cdkd#4339): after a secret rotation the
    // physical id is the PRE-rotation value, which this deploy's masker never
    // resolved, and a previous side still spelling `{{resolve:` makes it a
    // needle. The guard below keeps the deploy's own masker; every message of
    // this update reads this one.
    const { mask } = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [[previousProperties['DBProxyEndpointName'], physicalId]]
    );

    // Defensive: reject diffs in immutable fields. Replacement-rules.ts
    // SHOULD have routed those to a CREATE+DELETE replacement upstream, but
    // we double-check here so a missing rule entry doesn't silently corrupt
    // state (the PR #387 round 1 blocker class). A secret-derived value is
    // recorded as its `{{resolve:...}}` reference and handed here resolved,
    // which is no change; the physical id IS the endpoint name
    // (go-to-k/cdkd#4275).
    for (const field of ['DBProxyName', 'DBProxyEndpointName', 'VpcSubnetIds', 'TargetRole']) {
      if (
        JSON.stringify(properties[field]) !== JSON.stringify(previousProperties[field]) &&
        !(await unchangedBehindSecretReference({
          resourceType,
          key: field,
          desired: properties[field],
          previous: previousProperties[field],
          physicalName: field === 'DBProxyEndpointName' ? physicalId : undefined,
          maskSecrets: context?.maskSecrets,
        }))
      ) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${field} is immutable on AWS::RDS::DBProxyEndpoint — destroy + redeploy to change it`
        );
      }
    }

    // AWS only allows VpcSecurityGroupIds + NewDBProxyEndpointName on
    // ModifyDBProxyEndpoint. TargetRole / VpcSubnetIds / DBProxyName are
    // immutable (rejected above).
    const oldSG = (previousProperties['VpcSecurityGroupIds'] as string[]) ?? [];
    const newSG = (properties['VpcSecurityGroupIds'] as string[]) ?? [];
    if (JSON.stringify(oldSG) !== JSON.stringify(newSG)) {
      this.logger.debug(`Updating DBProxyEndpoint ${mask(physicalId)} security groups`);
      try {
        await client.send(
          new ModifyDBProxyEndpointCommand({
            DBProxyEndpointName: physicalId,
            VpcSecurityGroupIds: newSG,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE', resourceType, logicalId, physicalId, mask);
      }
    }

    // Invalidate attribute cache BEFORE applyTagDiff so the ARN warm-up
    // applyTagDiff performs survives across the update() call boundary
    // (PR #400 review M1: previously evicting after applyTagDiff wasted
    // the warm-up the next update() pays a Describe to re-create).
    this.invalidateAttributeCache(physicalId);

    await this.applyTagDiff(
      physicalId,
      previousProperties['Tags'],
      properties['Tags'],
      resourceType,
      logicalId,
      mask
    );

    return { physicalId, wasReplaced: false };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    const client = this.getClient();

    this.logger.debug(`Deleting DBProxyEndpoint ${physicalId}`);

    try {
      await client.send(new DeleteDBProxyEndpointCommand({ DBProxyEndpointName: physicalId }));
    } catch (error) {
      if (error instanceof DBProxyEndpointNotFoundFault || error instanceof DBProxyNotFoundFault) {
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `DBProxyEndpoint ${physicalId} or parent already gone, treating as success`
        );
        return;
      }
      throw this.wrapError(error, 'DELETE', resourceType, logicalId, physicalId);
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await client.send(new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId }));
      } catch (error) {
        if (
          error instanceof DBProxyEndpointNotFoundFault ||
          error instanceof DBProxyNotFoundFault
        ) {
          this.logger.debug(`DBProxyEndpoint ${physicalId} fully deleted`);
          return;
        }
        throw this.wrapError(error, 'DELETE (poll)', resourceType, logicalId, physicalId);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new ProvisioningError(
      `Timed out waiting for DBProxyEndpoint ${physicalId} to fully delete`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // ENCODED, not separated (go-to-k/cdkd#3496). A PRINTABLE separator here,
    // and both halves are unchecked: `physicalId` comes from a state record
    // that `parseStateBody` casts, and `attributeName` is template text. The
    // cache is read BEFORE the attribute switch below, so a hit answers
    // whatever was asked -- one AWS::RDS::DBProxyEndpoint's attribute served for
    // another's `Fn::GetAtt`.
    const cacheKey = injectiveKey(physicalId, attributeName);
    const cached = this.attributeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (
      attributeName !== 'Endpoint' &&
      attributeName !== 'DBProxyEndpointArn' &&
      attributeName !== 'IsDefault' &&
      attributeName !== 'VpcId'
    ) {
      this.logger.warn(
        `Unknown attribute ${attributeName} for AWS::RDS::DBProxyEndpoint, returning undefined`
      );
      return undefined;
    }

    try {
      const describe = await this.getClient().send(
        new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
      );
      const ep = describe.DBProxyEndpoints?.[0];
      if (!ep) return undefined;
      const map: Record<string, unknown> = {
        Endpoint: ep.Endpoint,
        DBProxyEndpointArn: ep.DBProxyEndpointArn,
        IsDefault: ep.IsDefault ?? false,
        VpcId: ep.VpcId,
      };
      const value = map[attributeName];
      if (value !== undefined) this.attributeCache.set(cacheKey, value);
      return value;
    } catch (error) {
      if (error instanceof DBProxyEndpointNotFoundFault || error instanceof DBProxyNotFoundFault) {
        return undefined;
      }
      throw error;
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBProxyEndpointName');
    if (explicit) {
      return this.buildImportResult(explicit);
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB proxy endpoint reaching here needs an explicit `--resource` override.
    return null;
  }

  async readCurrentState(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound> {
    const client = this.getClient();
    let ep: unknown;
    try {
      const describe = await client.send(
        new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
      );
      ep = describe.DBProxyEndpoints?.[0];
      if (!ep) return RESOURCE_NOT_FOUND;
    } catch (error) {
      // A gone parent proxy takes its endpoints with it.
      if (error instanceof DBProxyEndpointNotFoundFault || error instanceof DBProxyNotFoundFault) {
        return RESOURCE_NOT_FOUND;
      }
      throw error;
    }
    const e = ep as {
      DBProxyEndpointName?: string;
      DBProxyEndpointArn?: string;
      DBProxyName?: string;
      VpcSubnetIds?: string[];
      VpcSecurityGroupIds?: string[];
      TargetRole?: string;
    };
    const result: Record<string, unknown> = {
      DBProxyEndpointName: e.DBProxyEndpointName,
      DBProxyName: e.DBProxyName,
      VpcSubnetIds: e.VpcSubnetIds ?? [],
      VpcSecurityGroupIds: e.VpcSecurityGroupIds ?? [],
      TargetRole: e.TargetRole ?? 'READ_WRITE',
    };

    if (e.DBProxyEndpointArn) {
      try {
        const tagResp = await client.send(
          new ListTagsForResourceCommand({ ResourceName: e.DBProxyEndpointArn })
        );
        result['Tags'] = normalizeAwsTagsToCfn(tagResp.TagList ?? []);
      } catch (error) {
        this.logger.debug(
          `ListTagsForResource failed for ${physicalId}: ${describeAwsFailure(error).detail}`
        );
        result['Tags'] = [];
      }
    } else {
      result['Tags'] = [];
    }

    return result;
  }

  private async applyTagDiff(
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

    // Reviewer minor fix: skip the ARN-resolution Describe entirely when
    // there is no tag diff to apply.
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
    const arnCacheKey = injectiveKey(physicalId, 'DBProxyEndpointArn');
    let arn = this.attributeCache.get(arnCacheKey) as string | undefined;
    if (!arn) {
      try {
        const describe = await client.send(
          new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
        );
        arn = describe.DBProxyEndpoints?.[0]?.DBProxyEndpointArn;
        if (arn) this.attributeCache.set(arnCacheKey, arn);
      } catch (error) {
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
        throw this.wrapError(
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
        throw this.wrapError(
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

  private async buildImportResult(physicalId: string): Promise<ResourceImportResult> {
    try {
      const describe = await this.getClient().send(
        new DescribeDBProxyEndpointsCommand({ DBProxyEndpointName: physicalId })
      );
      const ep = describe.DBProxyEndpoints?.[0];
      // Only include keys the read-back actually resolved. Persisting `''`
      // is worse than omitting: the intrinsic resolver treats any
      // non-undefined flat attribute as a hit, so an empty string shadows
      // constructAttribute's fallback and Fn::GetAtt resolves to ''.
      // `IsDefault` is a genuine boolean, so `false` is a real value and is
      // kept whenever the endpoint was found at all.
      return {
        physicalId,
        attributes: {
          ...(ep?.Endpoint && { Endpoint: ep.Endpoint }),
          ...(ep?.DBProxyEndpointArn && { DBProxyEndpointArn: ep.DBProxyEndpointArn }),
          ...(ep && { IsDefault: ep.IsDefault ?? false }),
          ...(ep?.VpcId && { VpcId: ep.VpcId }),
        },
      };
    } catch {
      // Describe failed — we know nothing about the attributes. Return an
      // empty map rather than a set of empty-string placeholders.
      return { physicalId, attributes: {} };
    }
  }

  private invalidateAttributeCache(physicalId: string): void {
    // The prefix of the ENCODED key, not of the old separated one. This scan is
    // the reader go-to-k/cdkd#3496's first cut broke: the keys became
    // `["proxy-1","Endpoint"]` while this still tested `proxy-1:`, so it matched
    // NOTHING and every post-update `Fn::GetAtt` read the pre-update value. It
    // was silent — no test covered it and every gate stayed green.
    //
    // DERIVED from the encoder, never re-spelled here — re-spelling is exactly
    // what broke this scan. {@link injectiveKeyPrefix} carries why it is exact.
    const encodedPrefix = injectiveKeyPrefix(physicalId);
    for (const key of this.attributeCache.keys()) {
      if (key.startsWith(encodedPrefix)) this.attributeCache.delete(key);
    }
  }

  private wrapError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    // AWS can quote a secret-derived name, the pre-rotation one included
    // (go-to-k/cdkd#4339); stamped exactly when the mask changed its text.
    // Absent means unmasked.
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): ProvisioningError {
    const cause = error instanceof Error ? error : undefined;
    return wrapMaskedAwsError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `${op} failed for ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
