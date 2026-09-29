import {
  RDSClient,
  RegisterDBProxyTargetsCommand,
  DeregisterDBProxyTargetsCommand,
  DescribeDBProxyTargetGroupsCommand,
  DescribeDBProxyTargetsCommand,
  ModifyDBProxyTargetGroupCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  ListTagsForResourceCommand,
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
  DBProxyTargetNotFoundFault,
  type Tag,
} from '@aws-sdk/client-rds';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import type { CreateContext } from '../../types/resource.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { safeMsg } from '../../utils/display-safe.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../redacted-delete-address.js';

/**
 * AWS RDS DBProxyTargetGroup Provider
 *
 * Implements resource provisioning for `AWS::RDS::DBProxyTargetGroup`.
 *
 * **Why a dedicated SDK provider** (per `feedback_dedicated_provider_over_special_case.md`):
 * pre-PR this type went through Cloud Control API, but CC API's resource
 * handler for `AWS::RDS::DBProxyTargetGroup` fails the delete path with
 * `Value null at 'dBProxyName' failed to satisfy constraint`. The handler
 * cannot derive `DBProxyName` from the TargetGroup ARN (the primary
 * identifier), so the underlying RDS API call goes out with
 * `DBProxyName: null` and AWS rejects it (Issue #385).
 *
 * **What this resource actually does on AWS**: a CFn
 * `AWS::RDS::DBProxyTargetGroup` is a wiring resource — every DBProxy gets
 * a default TargetGroup (`TargetGroupName: 'default'`) auto-created by AWS;
 * the CFn resource only manages target REGISTRATIONS
 * (`RegisterDBProxyTargets` / `DeregisterDBProxyTargets`) and the
 * connection pool config (`ModifyDBProxyTargetGroup`). The TargetGroup
 * object itself is not deleted on resource delete — it lives and dies with
 * the parent DBProxy.
 *
 * **Lifecycle**:
 * - `create`: optionally `ModifyDBProxyTargetGroup` (connection pool), then
 *   `RegisterDBProxyTargets` (cluster IDs and / or instance IDs), then
 *   `DescribeDBProxyTargetGroups` to recover the TargetGroupArn for state,
 *   then `AddTagsToResource` on that ARN when `Tags` is declared (the schema
 *   is `tagOnCreate: false`, so tagging is always a separate call).
 * - `update`: pool config, target and `Tags` diffs in place (see `update()`).
 * - `delete`: `DeregisterDBProxyTargets` for every registered target.
 *   `DBProxyNotFoundFault` / `DBProxyTargetGroupNotFoundFault` /
 *   `DBProxyTargetNotFoundFault` are treated as idempotent success
 *   (region-match-gated) — the parent DBProxy may already have been
 *   deleted by a sibling cdkd delete or by AWS CASCADE.
 * - `getAttribute`: `TargetGroupArn` returns the physicalId; `TargetGroupName`
 *   returns `'default'`.
 *
 * **physicalId** = TargetGroupArn (matches the CFn `primaryIdentifier`).
 */
export class RDSDBProxyTargetGroupProvider implements ResourceProvider {
  private rdsClient?: RDSClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('RDSDBProxyTargetGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::RDS::DBProxyTargetGroup',
      new Set([
        'DBProxyName',
        'TargetGroupName',
        'DBClusterIdentifiers',
        'DBInstanceIdentifiers',
        'ConnectionPoolConfigurationInfo',
        'Tags',
      ]),
    ],
  ]);

  private getClient(): RDSClient {
    if (!this.rdsClient) {
      this.rdsClient = new RDSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.rdsClient;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const dbProxyName = properties['DBProxyName'] as string | undefined;
    if (!dbProxyName) {
      throw new ProvisioningError(
        `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    const targetGroupName = requireConfigString(
      properties['TargetGroupName'],
      'default',
      'AWS::RDS::DBProxyTargetGroup TargetGroupName',
      replayWarn(this.logger, context)
    );
    const dbClusterIdentifiers = properties['DBClusterIdentifiers'] as string[] | undefined;
    const dbInstanceIdentifiers = properties['DBInstanceIdentifiers'] as string[] | undefined;
    const connectionPoolConfig = properties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    // Refused before the first call: a malformed list would otherwise surface
    // only after the targets are registered. A state replay cannot fix its
    // record from the template, so there it warns and skips tagging, and the
    // key is dropped from what gets recorded.
    const tagRefusal = tagListRefusal(properties['Tags']);
    const skipTags = tagRefusal !== undefined && context?.replayingState === true;
    if (skipTags) {
      this.logger.warn(
        safeMsg`${logicalId}: the recorded Tags ${tagRefusal}; re-creating the target group without tags.`
      );
    }
    const tags = skipTags
      ? []
      : readTagList(properties['Tags'], resourceType, logicalId, undefined);

    const client = this.getClient();

    if (connectionPoolConfig) {
      this.logger.debug(`Applying connection pool config to ${dbProxyName}/${targetGroupName}`);
      try {
        await client.send(
          new ModifyDBProxyTargetGroupCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            ConnectionPoolConfig: connectionPoolConfig as never,
          })
        );
      } catch (error) {
        // An adjustment of the proxy's own target group, not the registration
        // this resource creates: never this resource's collision (#3826).
        throw markAuxiliaryFailure(
          this.wrapError(error, 'CREATE (pool config)', resourceType, logicalId, undefined),
          logicalId
        );
      }
    }

    if (
      (dbClusterIdentifiers && dbClusterIdentifiers.length > 0) ||
      (dbInstanceIdentifiers && dbInstanceIdentifiers.length > 0)
    ) {
      this.logger.debug(
        `Registering targets for ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${dbClusterIdentifiers?.join(',') ?? ''}], ` +
          `instances=[${dbInstanceIdentifiers?.join(',') ?? ''}]`
      );
      try {
        await client.send(
          new RegisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: dbClusterIdentifiers,
            DBInstanceIdentifiers: dbInstanceIdentifiers,
          })
        );
      } catch (error) {
        throw this.wrapError(
          error,
          'CREATE (register targets)',
          resourceType,
          logicalId,
          undefined
        );
      }
    }

    let targetGroupArn: string | undefined;
    try {
      const describeResponse = await client.send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      targetGroupArn = describeResponse.TargetGroups?.[0]?.TargetGroupArn;
    } catch (error) {
      throw this.wrapError(error, 'CREATE (describe)', resourceType, logicalId, undefined);
    }

    if (!targetGroupArn) {
      throw new ProvisioningError(
        `Failed to recover TargetGroupArn for ${dbProxyName}/${targetGroupName} after create`,
        resourceType,
        logicalId
      );
    }

    if (tags.length > 0) {
      try {
        await client.send(
          new AddTagsToResourceCommand({ ResourceName: targetGroupArn, Tags: tags })
        );
      } catch (error) {
        // The registration above is live and nothing will be recorded, so the
        // next deploy would register again over it: retire it first.
        throw await this.retireRegistrationAfterFailedCreate(
          this.wrapError(error, 'CREATE (add tags)', resourceType, logicalId, undefined),
          dbProxyName,
          targetGroupName,
          dbClusterIdentifiers,
          dbInstanceIdentifiers,
          context?.maskSecrets
        );
      }
    }

    return {
      physicalId: targetGroupArn,
      attributes: {
        TargetGroupArn: targetGroupArn,
        TargetGroupName: targetGroupName,
      },
      ...(skipTags && { effectiveProperties: withoutKey(properties, 'Tags') }),
    };
  }

  /**
   * In-place update support: target add/remove (DBClusterIdentifiers /
   * DBInstanceIdentifiers diff) via `RegisterDBProxyTargets` /
   * `DeregisterDBProxyTargets`, and ConnectionPoolConfigurationInfo
   * rewrite via `ModifyDBProxyTargetGroup`. DBProxyName + TargetGroupName
   * are part of the resource identity — a diff in either surfaces as
   * replacement upstream (not handled here).
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    const dbProxyName = properties['DBProxyName'] as string | undefined;
    if (!dbProxyName) {
      throw new ProvisioningError(
        `DBProxyName is required for AWS::RDS::DBProxyTargetGroup ${logicalId} update`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    // WARN, not throw: a rollback replays through `update()` with a historical
    // cdkd STATE record as the desired bag, so refusing here could leave a
    // resource un-rollbackable with no template-side remedy (issue #1513). The
    // `delete()` / `readCurrentState` reads below stay unguarded for the same
    // reason — both are state-side, never template-borne.
    //
    // Kept as a warning on EVERY caller, the template path included, when the
    // #3728 split was widened (issue #3740). `TargetGroupName` is createOnly
    // (CFn schema), so a changed value is a REPLACEMENT and never reaches
    // `update()`: a malformed value arriving here is one the recorded target
    // group already carries, and the only template edit that changes it
    // replaces the resource — not a repair a refusal could point at.
    const targetGroupName = requireConfigString(
      properties['TargetGroupName'],
      'default',
      'AWS::RDS::DBProxyTargetGroup TargetGroupName',
      { onUnusable: (message) => this.logger.warn(message) }
    );

    // Defensive: reject diffs in immutable identity fields. Replacement-rules.ts
    // SHOULD have routed those to a CREATE+DELETE replacement upstream; we
    // double-check here so a missing rule entry doesn't silently corrupt state.
    for (const field of ['DBProxyName', 'TargetGroupName']) {
      const oldVal = previousProperties[field];
      // Compare the GUARDED value for TargetGroupName, not the raw one. The
      // guard above may have warned and substituted 'default'; comparing the
      // raw `null` here would then throw `ResourceUpdateNotSupportedError` and
      // send the engine into a REPLACEMENT — making the warning's "using the
      // default for this update" a lie twelve lines after it was logged.
      const newVal = field === 'TargetGroupName' ? targetGroupName : properties[field];
      // TargetGroupName defaults to 'default' on AWS — treat undefined and
      // 'default' as equivalent on either side to avoid false-positive diff.
      const normalize = (v: unknown) =>
        field === 'TargetGroupName' && (v === undefined || v === 'default') ? 'default' : v;
      if (JSON.stringify(normalize(oldVal)) !== JSON.stringify(normalize(newVal))) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `${field} is immutable on AWS::RDS::DBProxyTargetGroup — destroy + redeploy to change it`
        );
      }
    }

    // Tags removals are the gap between the two lists, so a malformed DESIRED
    // list read as empty would strip every live tag: refused on every path,
    // before any call (issue #3948). A malformed RECORDED list only hides
    // removals, and every add is idempotent, so it degrades to adds alone.
    const desiredTags = readTagList(properties['Tags'], resourceType, logicalId, physicalId);
    const recordedTags = readRecordedTagList(previousProperties['Tags'], (message) =>
      this.logger.warn(safeMsg`${logicalId}: ${message}`)
    );

    const client = this.getClient();

    // 1. ConnectionPoolConfigurationInfo diff.
    const oldPool = previousProperties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    const newPool = properties['ConnectionPoolConfigurationInfo'] as
      | Record<string, unknown>
      | undefined;
    if (JSON.stringify(oldPool) !== JSON.stringify(newPool)) {
      this.logger.debug(`Updating connection pool config for ${dbProxyName}/${targetGroupName}`);
      try {
        await client.send(
          new ModifyDBProxyTargetGroupCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            // Pass new config (may be empty {} when user removed the block;
            // AWS treats empty as "reset to defaults").
            ConnectionPoolConfig: (newPool ?? {}) as never,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (pool config)', resourceType, logicalId, physicalId);
      }
    }

    // 2. Target diff: deregister removed, register added. Process clusters
    // and instances independently so the SDK call shape stays clean.
    const oldClusters = new Set((previousProperties['DBClusterIdentifiers'] as string[]) ?? []);
    const newClusters = new Set((properties['DBClusterIdentifiers'] as string[]) ?? []);
    const oldInstances = new Set((previousProperties['DBInstanceIdentifiers'] as string[]) ?? []);
    const newInstances = new Set((properties['DBInstanceIdentifiers'] as string[]) ?? []);

    const clustersToRemove = [...oldClusters].filter((c) => !newClusters.has(c));
    const clustersToAdd = [...newClusters].filter((c) => !oldClusters.has(c));
    const instancesToRemove = [...oldInstances].filter((i) => !newInstances.has(i));
    const instancesToAdd = [...newInstances].filter((i) => !oldInstances.has(i));

    if (clustersToRemove.length > 0 || instancesToRemove.length > 0) {
      this.logger.debug(
        `Deregistering targets from ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${clustersToRemove.join(',')}], instances=[${instancesToRemove.join(',')}]`
      );
      try {
        await client.send(
          new DeregisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: clustersToRemove.length > 0 ? clustersToRemove : undefined,
            DBInstanceIdentifiers: instancesToRemove.length > 0 ? instancesToRemove : undefined,
          })
        );
      } catch (error) {
        // Idempotent: a target that's already gone is fine — same shape
        // as delete()'s NotFound handling.
        if (!(error instanceof DBProxyTargetNotFoundFault)) {
          throw this.wrapError(error, 'UPDATE (deregister)', resourceType, logicalId, physicalId);
        }
      }
    }

    if (clustersToAdd.length > 0 || instancesToAdd.length > 0) {
      this.logger.debug(
        `Registering targets to ${dbProxyName}/${targetGroupName}: ` +
          `clusters=[${clustersToAdd.join(',')}], instances=[${instancesToAdd.join(',')}]`
      );
      try {
        await client.send(
          new RegisterDBProxyTargetsCommand({
            DBProxyName: dbProxyName,
            TargetGroupName: targetGroupName,
            DBClusterIdentifiers: clustersToAdd.length > 0 ? clustersToAdd : undefined,
            DBInstanceIdentifiers: instancesToAdd.length > 0 ? instancesToAdd : undefined,
          })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (register)', resourceType, logicalId, physicalId);
      }
    }

    // 3. Tags diff, addressed by the physicalId (the TargetGroupArn).
    const desiredByKey = new Map(desiredTags.map((t) => [t.Key!, t.Value ?? '']));
    const tagsToRemove =
      recordedTags === undefined
        ? []
        : recordedTags.filter((t) => !desiredByKey.has(t.Key!)).map((t) => t.Key!);
    const recordedByKey = new Map((recordedTags ?? []).map((t) => [t.Key!, t.Value ?? '']));
    const tagsToAdd = desiredTags.filter(
      (t) => recordedTags === undefined || recordedByKey.get(t.Key!) !== (t.Value ?? '')
    );
    if (tagsToRemove.length > 0) {
      try {
        await client.send(
          new RemoveTagsFromResourceCommand({ ResourceName: physicalId, TagKeys: tagsToRemove })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (remove tags)', resourceType, logicalId, physicalId);
      }
    }
    if (tagsToAdd.length > 0) {
      try {
        await client.send(
          new AddTagsToResourceCommand({ ResourceName: physicalId, Tags: tagsToAdd })
        );
      } catch (error) {
        throw this.wrapError(error, 'UPDATE (add tags)', resourceType, logicalId, physicalId);
      }
    }

    return { physicalId, wasReplaced: false };
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    const props = properties ?? {};
    // go-to-k/cdkd#3952: DeregisterDBProxyTargets names the proxy, the group
    // and each target from the record, and the NotFound faults below read as
    // "already gone" -- a redacted one would DROP the record over live targets.
    // The physicalId is the target group ARN, which names none of them.
    const redactedSkip = redactedDeleteAddressSkip(
      this.logger,
      logicalId,
      'DB proxy target group',
      redactedDeleteAddressFields({
        DBProxyName: props['DBProxyName'],
        TargetGroupName: props['TargetGroupName'],
        DBClusterIdentifiers: props['DBClusterIdentifiers'],
        DBInstanceIdentifiers: props['DBInstanceIdentifiers'],
      })
    );
    if (redactedSkip) return redactedSkip;
    const dbProxyName = props['DBProxyName'] as string | undefined;
    const targetGroupName = (props['TargetGroupName'] as string | undefined) ?? 'default';
    const dbClusterIdentifiers = props['DBClusterIdentifiers'] as string[] | undefined;
    const dbInstanceIdentifiers = props['DBInstanceIdentifiers'] as string[] | undefined;

    if (!dbProxyName) {
      // No way to deregister without DBProxyName. This shouldn't happen
      // when cdkd state was populated by this provider's create(), but
      // could occur on an imported / hand-edited state. Surface as a real
      // error rather than silently no-op so the user knows to clean up
      // manually.
      throw new ProvisioningError(
        `DBProxyName missing from state.properties for AWS::RDS::DBProxyTargetGroup ${logicalId}; cannot deregister targets. ` +
          `Manually run: aws rds deregister-db-proxy-targets --db-proxy-name <proxy-name> --target-group-name ${targetGroupName} ...`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const hasTargets =
      (dbClusterIdentifiers && dbClusterIdentifiers.length > 0) ||
      (dbInstanceIdentifiers && dbInstanceIdentifiers.length > 0);

    if (!hasTargets) {
      this.logger.debug(
        `No targets registered for ${dbProxyName}/${targetGroupName}; nothing to deregister`
      );
      return;
    }

    this.logger.debug(
      `Deregistering targets from ${dbProxyName}/${targetGroupName}: ` +
        `clusters=[${dbClusterIdentifiers?.join(',') ?? ''}], ` +
        `instances=[${dbInstanceIdentifiers?.join(',') ?? ''}]`
    );

    try {
      await this.getClient().send(
        new DeregisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: dbClusterIdentifiers,
          DBInstanceIdentifiers: dbInstanceIdentifiers,
        })
      );
    } catch (error) {
      // Idempotent success when the parent DBProxy, the TargetGroup, or
      // any individual target is already gone — typically because a sibling
      // cdkd delete or AWS-side CASCADE already removed them. Region-match
      // guard prevents silently masking a wrong-region destroy that would
      // otherwise leave the actual AWS resources orphaned.
      if (
        error instanceof DBProxyNotFoundFault ||
        error instanceof DBProxyTargetGroupNotFoundFault ||
        error instanceof DBProxyTargetNotFoundFault
      ) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `${dbProxyName}/${targetGroupName} or its target is already gone, treating as success`
        );
        return;
      }
      throw this.wrapError(error, 'DELETE', resourceType, logicalId, physicalId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- attribute resolution does not need AWS calls
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'TargetGroupArn':
        return physicalId;
      case 'TargetGroupName':
        return 'default';
      default:
        this.logger.warn(
          `Unknown attribute ${attributeName} for AWS::RDS::DBProxyTargetGroup, returning undefined`
        );
        return undefined;
    }
  }

  /**
   * Adopt an existing DBProxyTargetGroup into cdkd state.
   *
   * **Explicit override only.** AWS rejects `aws:`-prefixed tag writes, so
   * no `aws:cdk:path` tag exists to look the target group up by. Users must pass
   * `--resource <logicalId>=<TargetGroupArn>`.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      return {
        physicalId: input.knownPhysicalId,
        attributes: {
          TargetGroupArn: input.knownPhysicalId,
          TargetGroupName: 'default',
        },
      };
    }
    return null;
  }

  /**
   * Read the AWS-current configuration as CFn property shape. Used by
   * `cdkd drift` for the SDK-provider path (without it the comparator
   * falls back to CC API, which is broken on this type — Issue #385 the
   * SDK provider was added to fix in the first place).
   *
   * Maps:
   * - `DescribeDBProxyTargetGroups` → `ConnectionPoolConfigurationInfo`
   *   (the connection pool config CFn template carries).
   * - `DescribeDBProxyTargets` → `DBClusterIdentifiers` /
   *   `DBInstanceIdentifiers` reverse-mapped from the AWS-side target
   *   list via `Type` discriminator. The full target list also carries
   *   per-target Endpoint / Port / TargetHealth but those are read-only
   *   AWS-managed fields, intentionally not surfaced.
   *
   * Best-effort: a missing parent DBProxyName (state corruption) or any
   * AWS API failure surfaces as `undefined` (drift comparator skips the
   * resource), not a crash.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const dbProxyName = properties['DBProxyName'] as string | undefined;
    const targetGroupName = (properties['TargetGroupName'] as string | undefined) ?? 'default';
    if (!dbProxyName) {
      // No way to recover the AWS-side state without the parent name —
      // happens on imported / hand-edited state that lost DBProxyName.
      return undefined;
    }

    const client = this.getClient();

    let connectionPoolConfig: Record<string, unknown> | undefined;
    try {
      const tgResp = await client.send(
        new DescribeDBProxyTargetGroupsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      const tg = tgResp.TargetGroups?.[0];
      // AWS-side `ConnectionPoolConfig` (the Describe response shape) maps
      // 1:1 to the CFn `ConnectionPoolConfigurationInfo` field (the input
      // shape). Surfacing it always (even when AWS returns defaults) lets
      // a console-side change to MaxConnectionsPercent / etc. show as
      // drift on the v3 observedProperties baseline.
      connectionPoolConfig = tg?.ConnectionPoolConfig as Record<string, unknown> | undefined;
    } catch (error) {
      if (
        error instanceof DBProxyNotFoundFault ||
        error instanceof DBProxyTargetGroupNotFoundFault
      ) {
        return undefined;
      }
      throw error;
    }

    const dbClusterIdentifiers: string[] = [];
    const dbInstanceIdentifiers: string[] = [];
    try {
      const targetsResp = await client.send(
        new DescribeDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
        })
      );
      for (const target of targetsResp.Targets ?? []) {
        const id = target.RdsResourceId;
        if (!id) continue;
        if (target.Type === 'TRACKED_CLUSTER') {
          dbClusterIdentifiers.push(id);
        } else if (target.Type === 'RDS_INSTANCE') {
          dbInstanceIdentifiers.push(id);
        }
        // `RDS_SERVERLESS_ENDPOINT` targets are silently skipped — the
        // CFn `AWS::RDS::DBProxyTargetGroup` schema has no input slot for
        // them (only `DBClusterIdentifiers` / `DBInstanceIdentifiers`),
        // so they can't drift on a cdkd-managed target group.
      }
    } catch (error) {
      if (
        error instanceof DBProxyNotFoundFault ||
        error instanceof DBProxyTargetGroupNotFoundFault ||
        error instanceof DBProxyTargetNotFoundFault
      ) {
        return undefined;
      }
      throw error;
    }

    const result: Record<string, unknown> = {
      DBProxyName: dbProxyName,
      TargetGroupName: targetGroupName,
      DBClusterIdentifiers: dbClusterIdentifiers,
      DBInstanceIdentifiers: dbInstanceIdentifiers,
    };
    if (connectionPoolConfig !== undefined) {
      result['ConnectionPoolConfigurationInfo'] = connectionPoolConfig;
    }
    // Omitted, not `[]`, when the tag read fails: "could not read" must not
    // read as "has no tags".
    try {
      const tagResp = await client.send(
        new ListTagsForResourceCommand({ ResourceName: physicalId })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagResp.TagList ?? []);
    } catch (error) {
      this.logger.debug(
        safeMsg`ListTagsForResource failed for ${physicalId}: ${describeAwsFailure(error).detail}`
      );
    }
    return result;
  }

  /**
   * Deregister what a failing `create()` registered, then hand back the
   * ORIGINAL error — with the manual command appended when the cleanup
   * itself fails.
   */
  private async retireRegistrationAfterFailedCreate(
    original: ProvisioningError,
    dbProxyName: string,
    targetGroupName: string,
    dbClusterIdentifiers: string[] | undefined,
    dbInstanceIdentifiers: string[] | undefined,
    maskSecrets: ((text: string) => string) | undefined
  ): Promise<ProvisioningError> {
    const clusters = dbClusterIdentifiers?.length ? dbClusterIdentifiers : undefined;
    const instances = dbInstanceIdentifiers?.length ? dbInstanceIdentifiers : undefined;
    if (!clusters && !instances) return original;
    try {
      await this.getClient().send(
        new DeregisterDBProxyTargetsCommand({
          DBProxyName: dbProxyName,
          TargetGroupName: targetGroupName,
          DBClusterIdentifiers: clusters,
          DBInstanceIdentifiers: instances,
        })
      );
      return original;
    } catch (cleanupError) {
      // Template-chosen names, so the command renders through
      // `pasteableAwsCommand` (issue #3136) and is withheld rather than
      // printed inexactly.
      const aws = pasteableAwsCommand(maskSecrets);
      let targets = aws``;
      if (clusters) {
        targets = aws`${targets} --db-cluster-identifiers`;
        for (const id of clusters) targets = aws`${targets} ${id}`;
      }
      if (instances) {
        targets = aws`${targets} --db-instance-identifiers`;
        for (const id of instances) targets = aws`${targets} ${id}`;
      }
      original.message +=
        ` The targets this create registered are still registered and could not be ` +
        `deregistered (${describeAwsFailure(cleanupError).detail}). Manual cleanup: ` +
        aws`aws rds deregister-db-proxy-targets --db-proxy-name ${dbProxyName} --target-group-name ${targetGroupName}${targets}`.render();
      return original;
    }
  }

  private wrapError(
    error: unknown,
    op: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined
  ): ProvisioningError {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error : undefined;
    return new ProvisioningError(
      `${op} failed for ${logicalId}: ${message}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }
}

/**
 * Why a CFn `Tags` value cannot be sent, or `undefined` when it can. Absent
 * (`undefined` / `null`) is an empty list; anything else must be an array of
 * `{ Key: <non-empty string>, Value?: <string> }`.
 */
function tagListRefusal(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return `must be a list of { Key, Value } (got ${typeof value})`;
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return `entry ${index} must be a { Key, Value } object`;
    }
    const { Key: key, Value: tagValue } = entry as Record<string, unknown>;
    if (typeof key !== 'string' || key.length === 0) {
      return `entry ${index} needs a non-empty string Key`;
    }
    if (tagValue != null && typeof tagValue !== 'string') {
      return `entry ${index} (${key}) has a non-string Value`;
    }
  }
  return undefined;
}

function toSdkTags(value: unknown): Tag[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<{ Key: string; Value?: string | null }>).map((t) => ({
    Key: t.Key,
    Value: t.Value ?? '',
  }));
}

/** The DESIRED `Tags`, refused before any call when malformed. */
function readTagList(
  value: unknown,
  resourceType: string,
  logicalId: string,
  physicalId: string | undefined
): Tag[] {
  const refusal = tagListRefusal(value);
  if (refusal !== undefined) {
    throw new ProvisioningError(
      safeMsg`${resourceType} ${logicalId}: Tags ${refusal}. Nothing was changed.`,
      resourceType,
      logicalId,
      physicalId
    );
  }
  return toSdkTags(value);
}

/**
 * The RECORDED `Tags`: `undefined` when malformed, which the caller reads as
 * "removals unknown" and answers with adds alone.
 */
function readRecordedTagList(value: unknown, warn: (message: string) => void): Tag[] | undefined {
  const refusal = tagListRefusal(value);
  if (refusal !== undefined) {
    warn(
      `the recorded Tags ${refusal}; applying the desired tags without removing any, ` +
        `so a tag the template dropped may remain on the target group.`
    );
    return undefined;
  }
  return toSdkTags(value);
}

function withoutKey(bag: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = bag;
  return rest;
}
