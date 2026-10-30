import {
  RDSClient,
  CreateDBProxyCommand,
  ModifyDBProxyCommand,
  DeleteDBProxyCommand,
  DescribeDBProxiesCommand,
  ListTagsForResourceCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  DBProxyNotFoundFault,
  type UserAuthConfig,
  type DefaultAuthScheme,
  type EndpointNetworkType,
  type EngineFamily,
  type TargetConnectionNetworkType,
  type Tag,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generatedNameFor } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import {
  planTagDiff,
  tagPlanWarning,
  refuseMalformedDesiredTags,
  DBPROXY_TAG_OPTIONS,
  DBPROXY_TAGS_WHAT,
} from '../tag-list.js';
import type {
  CreateContext,
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
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { markNotGone } from '../not-gone.js';
import { injectiveKey, injectiveKeyPrefix } from '../../state/record-keys.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { safeMsg } from '../../utils/display-safe.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Issue #1160: the optional, mutable properties whose REMOVAL from the
 * template leaves the live value in place. `ModifyDBProxy` keeps any setting
 * it is not sent, and cdkd sends no reset. The update warns instead of
 * staying silent. `RoleArn` is required, and the create-only properties
 * replace the proxy, so neither belongs here. `Auth` is retained only where
 * the update does not refuse its removal ({@link authRemovalRefused}).
 * `DefaultAuthScheme` (go-to-k/cdkd#2762) is mutable through `ModifyDBProxy`
 * and is retained the same way; CloudFormation's behavior on its removal is
 * not measured, so it is not in {@link CFN_KEEPS_ON_REMOVAL}.
 */
const RETAINED_ON_REMOVAL: readonly string[] = [
  'Auth',
  'DefaultAuthScheme',
  'RequireTLS',
  'IdleClientTimeout',
  'DebugLogging',
  'VpcSecurityGroupIds',
];

/**
 * The {@link RETAINED_ON_REMOVAL} properties CloudFormation is MEASURED to keep
 * too (CFn A/B us-east-1 2026-10-22: `RequireTLS` true, `IdleClientTimeout`
 * 900, `DebugLogging` true and a custom `VpcSecurityGroupIds` removed together
 * left every live value in place, and the update succeeded). `Auth` is not
 * here: CloudFormation sends its removal, so a warning naming it claims
 * nothing about CloudFormation.
 */
const CFN_KEEPS_ON_REMOVAL: ReadonlySet<string> = new Set([
  'RequireTLS',
  'IdleClientTimeout',
  'DebugLogging',
  'VpcSecurityGroupIds',
]);

/**
 * Issue #1160: whether `update()` refuses an `Auth` removal. AWS requires
 * `Auth` while `DefaultAuthScheme` is `NONE` or unset, and CloudFormation
 * sends the removal, so its update fails (CFn A/B us-east-1 2026-10-22:
 * `UPDATE_FAILED`, "the 'Auth' parameter is required when the
 * 'defaultAuthScheme' parameter is set to NONE or not specified"). cdkd
 * refuses the same deploy before any call. With `DefaultAuthScheme` set to
 * another value (`IAM_AUTH`), CloudFormation's removal would be accepted, so
 * nothing is refused; cdkd sends no `Auth` reset, so the proxy keeps its live
 * `Auth` and the update warns ({@link RETAINED_ON_REMOVAL}).
 */
const authRemovalRefused = (
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean =>
  // The scheme the proxy will HOLD: a removed `DefaultAuthScheme` is not sent
  // (RETAINED_ON_REMOVAL), so the live value is still the previous one.
  authRequired({
    DefaultAuthScheme:
      properties['DefaultAuthScheme'] !== undefined
        ? properties['DefaultAuthScheme']
        : previousProperties['DefaultAuthScheme'],
  });

/**
 * Whether an update would leave the proxy with no `Auth` while AWS requires
 * one (go-to-k/cdkd#2762); the shapes are named at its call in `update()`.
 */
const leavesProxyWithoutAuth = (
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean => {
  const desired = properties['Auth'];
  const declaredEmpty = desired === null || (Array.isArray(desired) && desired.length === 0);
  const switchesToNone =
    properties['DefaultAuthScheme'] === 'NONE' &&
    previousProperties['DefaultAuthScheme'] !== 'NONE';
  if (switchesToNone && (desired === undefined || declaredEmpty)) return true;
  return (
    declaredEmpty &&
    JSON.stringify(desired) !== JSON.stringify(previousProperties['Auth']) &&
    authRemovalRefused(properties, previousProperties)
  );
};

/**
 * Whether AWS requires `Auth` for the proxy the bag describes: while
 * `DefaultAuthScheme` is `NONE` or unset (AWS's own refusal, quoted above;
 * the CFn schema does not list `Auth` as required).
 * `create()` refuses a proxy without `Auth` only then, so a template declaring
 * `DefaultAuthScheme: IAM_AUTH` alone deploys, as on CloudFormation
 * (go-to-k/cdkd#2762).
 */
const authRequired = (properties: Record<string, unknown>): boolean => {
  const scheme = properties['DefaultAuthScheme'];
  return scheme === undefined || scheme === 'NONE';
};

/**
 * AWS RDS DBProxy Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxy`.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * keeps the AWS::RDS::DBProxy family (DBProxy + DBProxyTargetGroup) on one
 * codebase. Pre-PR DBProxy went through CC API, which worked for create
 * and delete but the sibling DBProxyTargetGroup type was broken — moving
 * the parent type to a dedicated provider ensures the whole family is
 * consistent and lets us evolve both surfaces together (e.g. shared
 * `DescribeDBProxies` calls in future enrichment, common error handling).
 *
 * **Lifecycle**:
 * - `create`: `CreateDBProxyCommand`, then poll `DescribeDBProxies` until
 *   `DBProxyStatus === 'available'`. Returns physicalId=DBProxyName plus
 *   `Endpoint` / `DBProxyArn` / `VpcId` in attributes.
 * - `update`: `ModifyDBProxyCommand` for the mutable fields (Auth /
 *   DefaultAuthScheme / DebugLogging / IdleClientTimeout / RequireTLS /
 *   RoleArn / SecurityGroups); a removed field is left at its live value and
 *   warned about (`RETAINED_ON_REMOVAL`), except an `Auth` removal AWS would
 *   refuse, which is refused before any call (`authRemovalRefused`). Tags
 *   handled via separate `AddTagsToResource` / `RemoveTagsFromResource` diff.
 *   EngineFamily, VpcSubnetIds, EndpointNetworkType and
 *   TargetConnectionNetworkType are immutable on AWS (create-only in the CFn
 *   schema, no `ModifyDBProxy` member; go-to-k/cdkd#2762); a diff in those
 *   surfaces as `ResourceReplacement` from the deploy engine, not handled here.
 * - `delete`: `DeleteDBProxyCommand`, then poll for `DBProxyNotFoundFault`
 *   to confirm full removal (AWS keeps the proxy in `deleting` state for
 *   ~30-60s after the delete returns). `DBProxyNotFoundFault` at any
 *   point is treated as idempotent success (region-match-gated).
 * - `getAttribute`: `DescribeDBProxies` for `Endpoint` / `DBProxyArn` /
 *   `VpcId`, cached per `(physicalId, attribute)`.
 * - `import`: explicit `--resource` override or the template's
 *   `DBProxyName` property (issue #1134 removed the unreachable
 *   `aws:cdk:path` tag walk).
 *
 * **physicalId** = DBProxyName (matches CFn `primaryIdentifier`).
 */
export class RDSDBProxyProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private createClient?: RDSClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('RDSDBProxyProvider');
  private readonly attributeCache = new Map<string, unknown>();

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxy',
      new Set([
        'DBProxyName',
        'EngineFamily',
        'Auth',
        'RoleArn',
        'VpcSubnetIds',
        'VpcSecurityGroupIds',
        'RequireTLS',
        'IdleClientTimeout',
        'DebugLogging',
        'DefaultAuthScheme',
        'EndpointNetworkType',
        'TargetConnectionNetworkType',
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
   * The client `CreateDBProxy` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateDBProxy` carries no idempotency token and the proxy name is unique per
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
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = maskerOrIdentity(context?.maskSecrets);
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
    const dbProxyName =
      (properties['DBProxyName'] as string | undefined) ??
      generatedNameFor('AWS::RDS::DBProxy', logicalId);
    const engineFamily = properties['EngineFamily'] as EngineFamily | undefined;
    if (!engineFamily) {
      throw new ProvisioningError(
        `EngineFamily is required for AWS::RDS::DBProxy ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const auth = properties['Auth'] as UserAuthConfig[] | undefined;
    if ((!auth || auth.length === 0) && authRequired(properties)) {
      throw new ProvisioningError(
        `Auth (at least one entry) is required for AWS::RDS::DBProxy ${logicalId} while DefaultAuthScheme is NONE or unset`,
        resourceType,
        logicalId
      );
    }
    const roleArn = properties['RoleArn'] as string | undefined;
    if (!roleArn) {
      throw new ProvisioningError(
        `RoleArn is required for AWS::RDS::DBProxy ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const vpcSubnetIds = properties['VpcSubnetIds'] as string[] | undefined;
    if (!vpcSubnetIds || vpcSubnetIds.length === 0) {
      throw new ProvisioningError(
        `VpcSubnetIds (at least one) is required for AWS::RDS::DBProxy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const client = this.getClient();

    this.logger.debug(mask(`Creating DBProxy ${dbProxyName} (${engineFamily})`));

    try {
      await this.getCreateClient().send(
        new CreateDBProxyCommand({
          DBProxyName: dbProxyName,
          EngineFamily: engineFamily,
          Auth: auth && auth.length > 0 ? auth : undefined,
          DefaultAuthScheme: properties['DefaultAuthScheme'] as DefaultAuthScheme | undefined,
          EndpointNetworkType: properties['EndpointNetworkType'] as EndpointNetworkType | undefined,
          TargetConnectionNetworkType: properties['TargetConnectionNetworkType'] as
            | TargetConnectionNetworkType
            | undefined,
          RoleArn: roleArn,
          VpcSubnetIds: vpcSubnetIds,
          VpcSecurityGroupIds: properties['VpcSecurityGroupIds'] as string[] | undefined,
          RequireTLS: properties['RequireTLS'] as boolean | undefined,
          IdleClientTimeout: properties['IdleClientTimeout'] as number | undefined,
          DebugLogging: properties['DebugLogging'] as boolean | undefined,
          Tags: tags.length > 0 ? tags : undefined,
        })
      );
    } catch (error) {
      throw this.wrapCaughtError(error, 'CREATE', resourceType, logicalId, undefined, mask);
    }
    // go-to-k/cdkd#5511: reported before the available poll.
    reportCreatedResource(logicalId, resourceType, dbProxyName);

    // Wait until DBProxyStatus = 'available'. Post-create wiring (Targets via
    // RDSDBProxyTargetGroupProvider.create()) requires the proxy to be
    // available, so blocking here keeps the deploy engine's DAG consistent.
    let endpoint: string | undefined;
    let dbProxyArn: string | undefined;
    let vpcId: string | undefined;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let status: string | undefined;
    try {
      while (Date.now() < deadline) {
        try {
          const describe = await client.send(
            new DescribeDBProxiesCommand({ DBProxyName: dbProxyName })
          );
          const proxy = describe.DBProxies?.[0];
          status = proxy?.Status;
          if (status === 'available') {
            endpoint = proxy?.Endpoint;
            dbProxyArn = proxy?.DBProxyArn;
            vpcId = proxy?.VpcId;
            break;
          }
          if (status === 'incompatible-network' || status === 'insufficient-resource-limits') {
            throw new ProvisioningError(
              `DBProxy ${dbProxyName} entered terminal failure state: ${status}`,
              resourceType,
              logicalId,
              dbProxyName
            );
          }
        } catch (error) {
          if (error instanceof DBProxyNotFoundFault) {
            // Not yet visible — keep polling.
          } else if (error instanceof ProvisioningError) {
            throw error;
          } else {
            throw this.wrapCaughtError(
              error,
              'CREATE (poll)',
              resourceType,
              logicalId,
              dbProxyName,
              mask
            );
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      if (!endpoint || !dbProxyArn) {
        throw new ProvisioningError(
          `Timed out waiting for DBProxy ${dbProxyName} to become available (last status: ${status ?? 'unknown'})`,
          resourceType,
          logicalId,
          dbProxyName
        );
      }
    } catch (error) {
      // go-to-k/cdkd#4583: CreateDBProxy returned, so the proxy exists under
      // `dbProxyName` (the id delete() takes); name it for --revert-failed.
      markCreatedBeforeFailure(error, logicalId, resourceType, dbProxyName);
      throw error;
    }

    return {
      physicalId: dbProxyName,
      attributes: definedAttributes({
        DBProxyArn: dbProxyArn,
        Endpoint: endpoint,
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
   * Issue #1160: one warning naming each {@link RETAINED_ON_REMOVAL} property
   * the template dropped ({@link removedRetained}).
   */
  private warnOnRetainedRemovals(
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
  private removedRetained(
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

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    const client = this.getClient();
    const mask = maskerOrIdentity(context?.maskSecrets);

    this.logger.debug(`Deleting DBProxy ${physicalId}`);

    try {
      await client.send(new DeleteDBProxyCommand({ DBProxyName: physicalId }));
    } catch (error) {
      if (error instanceof DBProxyNotFoundFault) {
        const clientRegion = await client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DBProxy ${physicalId} already gone, treating as success`);
        return;
      }
      throw this.wrapDeleteError(error, 'DELETE', resourceType, logicalId, physicalId, mask);
    }

    // Wait for the proxy to fully disappear. AWS keeps the resource in
    // `deleting` state for ~30-60s before DescribeDBProxies starts
    // returning DBProxyNotFoundFault — without this wait, a subsequent
    // `cdkd deploy` of a same-named proxy can race AWS's eventual delete.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
      } catch (error) {
        if (error instanceof DBProxyNotFoundFault) {
          this.logger.debug(`DBProxy ${physicalId} fully deleted`);
          return;
        }
        throw this.wrapDeleteError(
          error,
          'DELETE (poll)',
          resourceType,
          logicalId,
          physicalId,
          mask
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new ProvisioningError(
      `Timed out waiting for DBProxy ${physicalId} to fully delete`,
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
    // whatever was asked -- one AWS::RDS::DBProxy's attribute served for
    // another's `Fn::GetAtt`.
    const cacheKey = injectiveKey(physicalId, attributeName);
    const cached = this.attributeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (
      attributeName !== 'Endpoint' &&
      attributeName !== 'DBProxyArn' &&
      attributeName !== 'VpcId'
    ) {
      this.logger.warn(
        `Unknown attribute ${attributeName} for AWS::RDS::DBProxy, returning undefined`
      );
      return undefined;
    }

    try {
      const describe = await this.getClient().send(
        new DescribeDBProxiesCommand({ DBProxyName: physicalId })
      );
      const proxy = describe.DBProxies?.[0];
      if (!proxy) return undefined;
      const map: Record<string, unknown> = {
        Endpoint: proxy.Endpoint,
        DBProxyArn: proxy.DBProxyArn,
        VpcId: proxy.VpcId,
      };
      const value = map[attributeName];
      if (value !== undefined) this.attributeCache.set(cacheKey, value);
      return value;
    } catch (error) {
      if (error instanceof DBProxyNotFoundFault) return undefined;
      throw error;
    }
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DBProxyName');
    if (explicit) {
      return this.buildImportResult(explicit);
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // `DescribeStackResources` or the template's physical-name property; a
    // DB proxy reaching here needs an explicit `--resource` override.
    return null;
  }

  /**
   * Reads the AWS-current configuration. Drift comparator uses this as the
   * authoritative snapshot for resources written under schema v3+.
   */
  async readCurrentState(physicalId: string): Promise<Record<string, unknown> | ResourceNotFound> {
    const client = this.getClient();
    let proxy: unknown;
    try {
      const describe = await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
      proxy = describe.DBProxies?.[0];
      if (!proxy) return RESOURCE_NOT_FOUND;
    } catch (error) {
      if (error instanceof DBProxyNotFoundFault) return RESOURCE_NOT_FOUND;
      throw error;
    }
    const p = proxy as {
      DBProxyName?: string;
      DBProxyArn?: string;
      EngineFamily?: string;
      RoleArn?: string;
      VpcSubnetIds?: string[];
      VpcSecurityGroupIds?: string[];
      RequireTLS?: boolean;
      IdleClientTimeout?: number;
      DebugLogging?: boolean;
      DefaultAuthScheme?: string;
      EndpointNetworkType?: string;
      TargetConnectionNetworkType?: string;
      Auth?: Array<{
        Description?: string;
        UserName?: string;
        AuthScheme?: string;
        SecretArn?: string;
        IAMAuth?: string;
        ClientPasswordAuthType?: string;
      }>;
    };
    const result: Record<string, unknown> = {
      DBProxyName: p.DBProxyName,
      EngineFamily: p.EngineFamily,
      RoleArn: p.RoleArn,
      VpcSubnetIds: p.VpcSubnetIds ?? [],
      VpcSecurityGroupIds: p.VpcSecurityGroupIds ?? [],
      RequireTLS: p.RequireTLS ?? false,
      IdleClientTimeout: p.IdleClientTimeout,
      DebugLogging: p.DebugLogging ?? false,
      Auth: (p.Auth ?? []).map((a) => ({
        Description: a.Description,
        UserName: a.UserName,
        AuthScheme: a.AuthScheme,
        SecretArn: a.SecretArn,
        IAMAuth: a.IAMAuth,
        ClientPasswordAuthType: a.ClientPasswordAuthType,
      })),
      // Omitted when AWS reports none: the drift comparator ignores a key
      // state does not hold, and a proxy created without the property records
      // none (go-to-k/cdkd#2762).
      ...(p.DefaultAuthScheme !== undefined && { DefaultAuthScheme: p.DefaultAuthScheme }),
      ...(p.EndpointNetworkType !== undefined && { EndpointNetworkType: p.EndpointNetworkType }),
      ...(p.TargetConnectionNetworkType !== undefined && {
        TargetConnectionNetworkType: p.TargetConnectionNetworkType,
      }),
    };

    // Tags via ListTagsForResource.
    if (p.DBProxyArn) {
      try {
        const tagResp = await client.send(
          new ListTagsForResourceCommand({ ResourceName: p.DBProxyArn })
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
        const describe = await client.send(
          new DescribeDBProxiesCommand({ DBProxyName: physicalId })
        );
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

  private async buildImportResult(physicalId: string): Promise<ResourceImportResult> {
    // Recover attributes via DescribeDBProxies so the imported resource
    // gets the same shape a fresh create() would produce.
    try {
      const describe = await this.getClient().send(
        new DescribeDBProxiesCommand({ DBProxyName: physicalId })
      );
      const proxy = describe.DBProxies?.[0];
      // Only include keys the read-back actually resolved. Persisting `''`
      // is worse than omitting: the intrinsic resolver treats any
      // non-undefined flat attribute as a hit, so an empty string shadows
      // constructAttribute's fallback and Fn::GetAtt resolves to ''.
      return {
        physicalId,
        attributes: {
          ...(proxy?.DBProxyArn && { DBProxyArn: proxy.DBProxyArn }),
          ...(proxy?.Endpoint && { Endpoint: proxy.Endpoint }),
          ...(proxy?.VpcId && { VpcId: proxy.VpcId }),
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

  /**
   * The failure wrap this provider's create, update, delete and tag catches
   * throw.
   *
   * An AWS-authored failure reaches the message as its CLASS plus the
   * `--verbose` pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an RDS `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}); this provider marks
   * no post-create call auxiliary, so nothing gates it. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, go-to-k/cdkd#4339); a non-`Error` throw is withheld
   * like an AWS one, unstamped (it has no chain). A delete catch tests
   * not-found by type before it wraps.
   */
  private wrapCaughtError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    // AWS can quote a secret-derived name, the pre-rotation one included
    // (go-to-k/cdkd#4339). Absent means unmasked.
    mask: MaskerFn = maskerOrIdentity(undefined)
  ): ProvisioningError {
    const cause = error instanceof Error ? error : undefined;
    const build = (text: string): ProvisioningError =>
      new ProvisioningError(
        `${op} failed for ${logicalId}: ${text}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * {@link wrapCaughtError} for a delete catch. The wrap names an AWS failure
   * by its CLASS, and the delete classifiers read `NotFound` in a message as
   * "already deleted": a class naming ANOTHER object's not-found (the typed
   * not-found of this resource returned before the wrap) is marked
   * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
   */
  private wrapDeleteError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string,
    mask: MaskerFn
  ): ProvisioningError {
    const thrown = this.wrapCaughtError(error, op, resourceType, logicalId, physicalId, mask);
    return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
