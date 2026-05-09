import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteIndexPolicyCommand,
  DeleteLogGroupCommand,
  DescribeIndexPoliciesCommand,
  DescribeLogGroupsCommand,
  GetDataProtectionPolicyCommand,
  ListTagsForResourceCommand,
  PutBearerTokenAuthenticationCommand,
  PutIndexPolicyCommand,
  PutLogGroupDeletionProtectionCommand,
  PutRetentionPolicyCommand,
  DeleteRetentionPolicyCommand,
  TagResourceCommand,
  UntagResourceCommand,
  PutDataProtectionPolicyCommand,
  DeleteDataProtectionPolicyCommand,
  ResourceNotFoundException,
  ResourceAlreadyExistsException,
} from '@aws-sdk/client-cloudwatch-logs';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS CloudWatch Logs LogGroup Provider
 *
 * Implements resource provisioning for AWS::Logs::LogGroup using the CloudWatch Logs SDK.
 * WHY: CreateLogGroup is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class LogsLogGroupProvider implements ResourceProvider {
  private logsClient: CloudWatchLogsClient;
  private stsClient: STSClient;
  private logger = getLogger().child('LogsLogGroupProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Logs::LogGroup',
      new Set([
        'LogGroupName',
        'KmsKeyId',
        'RetentionInDays',
        'Tags',
        'DataProtectionPolicy',
        'LogGroupClass',
        'FieldIndexPolicies',
        'ResourcePolicyDocument',
        'DeletionProtectionEnabled',
        'BearerTokenAuthenticationEnabled',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.logsClient = awsClients.cloudWatchLogs;
    this.stsClient = awsClients.sts;
  }

  /**
   * Create a CloudWatch Logs log group
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating log group ${logicalId}`);

    const logGroupName =
      (properties['LogGroupName'] as string | undefined) ||
      `/cdkd/${generateResourceName(logicalId, { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`;

    try {
      const createParams: import('@aws-sdk/client-cloudwatch-logs').CreateLogGroupCommandInput = {
        logGroupName,
      };
      if (properties['KmsKeyId']) createParams.kmsKeyId = properties['KmsKeyId'] as string;
      if (properties['LogGroupClass']) {
        createParams.logGroupClass = properties[
          'LogGroupClass'
        ] as import('@aws-sdk/client-cloudwatch-logs').LogGroupClass;
      }
      // DeletionProtectionEnabled is part of CreateLogGroupRequest and can
      // be applied in the same call. AWS rejects unknown / undefined values,
      // so only forward when the property is explicitly present.
      if (properties['DeletionProtectionEnabled'] !== undefined) {
        createParams.deletionProtectionEnabled = properties['DeletionProtectionEnabled'] as boolean;
      }
      if (properties['Tags']) {
        const cfnTags = properties['Tags'] as Array<{ Key: string; Value: string }>;
        createParams.tags = Object.fromEntries(cfnTags.map((t) => [t.Key, t.Value]));
      }

      await this.logsClient.send(new CreateLogGroupCommand(createParams));

      // Apply retention policy if specified
      const retentionInDays = properties['RetentionInDays'] as number | undefined;
      if (retentionInDays) {
        await this.logsClient.send(
          new PutRetentionPolicyCommand({
            logGroupName,
            retentionInDays,
          })
        );
      }

      // Apply DataProtectionPolicy if specified
      if (properties['DataProtectionPolicy']) {
        const policyDocument =
          typeof properties['DataProtectionPolicy'] === 'string'
            ? properties['DataProtectionPolicy']
            : JSON.stringify(properties['DataProtectionPolicy']);
        await this.logsClient.send(
          new PutDataProtectionPolicyCommand({
            logGroupIdentifier: logGroupName,
            policyDocument,
          })
        );
      }

      // Apply FieldIndexPolicies. CloudWatch Logs allows at most one
      // log-group-level index policy at a time (see PutIndexPolicy /
      // DeleteIndexPolicy semantics — both key on logGroupIdentifier
      // alone, no policyName), so the CFn `FieldIndexPolicies` array is
      // effectively 0-or-1. Apply the first entry; warn if more are
      // supplied.
      const fieldIndexPolicies = properties['FieldIndexPolicies'] as unknown[] | undefined;
      if (fieldIndexPolicies && fieldIndexPolicies.length > 0) {
        if (fieldIndexPolicies.length > 1) {
          this.logger.debug(
            `Log group ${logicalId} declares ${fieldIndexPolicies.length} FieldIndexPolicies; AWS only supports one log-group-level field index policy. Applying the first.`
          );
        }
        const first = fieldIndexPolicies[0];
        const policyDocument = typeof first === 'string' ? first : JSON.stringify(first);
        await this.logsClient.send(
          new PutIndexPolicyCommand({
            logGroupIdentifier: logGroupName,
            policyDocument,
          })
        );
      }

      // Apply BearerTokenAuthenticationEnabled. Not part of
      // CreateLogGroupRequest — needs a separate
      // PutBearerTokenAuthentication call after the log group exists.
      if (properties['BearerTokenAuthenticationEnabled'] !== undefined) {
        await this.logsClient.send(
          new PutBearerTokenAuthenticationCommand({
            logGroupIdentifier: logGroupName,
            bearerTokenAuthenticationEnabled: properties[
              'BearerTokenAuthenticationEnabled'
            ] as boolean,
          })
        );
      }

      // Note: ResourcePolicyDocument is declared in handledProperties to
      // prevent CC API fallback but is not yet wired into create/update —
      // it maps to the separate AWS::Logs::ResourcePolicy resource type
      // (account-wide, not per-log-group).

      this.logger.debug(`Successfully created log group ${logicalId}: ${logGroupName}`);

      // Construct ARN from region/account
      const arn = await this.buildArn(logGroupName);

      return {
        physicalId: logGroupName,
        attributes: {
          Arn: arn,
        },
      };
    } catch (error) {
      if (error instanceof ResourceAlreadyExistsException) {
        this.logger.debug(`Log group ${logGroupName} already exists, using existing`);
        const arn = await this.buildArn(logGroupName);
        return {
          physicalId: logGroupName,
          attributes: {
            Arn: arn,
          },
        };
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create log group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        logGroupName,
        cause
      );
    }
  }

  /**
   * Update a CloudWatch Logs log group
   *
   * Mutable: `RetentionInDays`, `DataProtectionPolicy`, `Tags`,
   * `DeletionProtectionEnabled`, `BearerTokenAuthenticationEnabled`,
   * `FieldIndexPolicies`. `LogGroupName` / `KmsKeyId` / `LogGroupClass`
   * are immutable on AWS-side and require replacement.
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating log group ${logicalId}: ${physicalId}`);

    // Update retention policy if changed
    const retentionInDays = properties['RetentionInDays'] as number | undefined;
    const oldRetentionInDays = previousProperties['RetentionInDays'] as number | undefined;
    if (retentionInDays !== oldRetentionInDays) {
      if (retentionInDays) {
        await this.logsClient.send(
          new PutRetentionPolicyCommand({
            logGroupName: physicalId,
            retentionInDays,
          })
        );
      } else {
        // Remove retention policy (never expire)
        await this.logsClient.send(
          new DeleteRetentionPolicyCommand({
            logGroupName: physicalId,
          })
        );
      }
    }

    // Update DataProtectionPolicy if changed
    if (
      JSON.stringify(properties['DataProtectionPolicy']) !==
      JSON.stringify(previousProperties['DataProtectionPolicy'])
    ) {
      if (properties['DataProtectionPolicy']) {
        const policyDocument =
          typeof properties['DataProtectionPolicy'] === 'string'
            ? properties['DataProtectionPolicy']
            : JSON.stringify(properties['DataProtectionPolicy']);
        await this.logsClient.send(
          new PutDataProtectionPolicyCommand({
            logGroupIdentifier: physicalId,
            policyDocument,
          })
        );
      } else {
        await this.logsClient.send(
          new DeleteDataProtectionPolicyCommand({
            logGroupIdentifier: physicalId,
          })
        );
      }
    }

    // Update DeletionProtectionEnabled if changed. Use !== undefined so
    // explicit `false` is honored (drift --revert needs to be able to
    // clear a console-side enable).
    if (
      properties['DeletionProtectionEnabled'] !== previousProperties['DeletionProtectionEnabled']
    ) {
      const next = properties['DeletionProtectionEnabled'];
      if (next !== undefined) {
        await this.logsClient.send(
          new PutLogGroupDeletionProtectionCommand({
            logGroupIdentifier: physicalId,
            deletionProtectionEnabled: next as boolean,
          })
        );
      } else {
        // State went from set -> undefined. AWS-side default is false;
        // disable explicitly so the round-trip lands at the default.
        await this.logsClient.send(
          new PutLogGroupDeletionProtectionCommand({
            logGroupIdentifier: physicalId,
            deletionProtectionEnabled: false,
          })
        );
      }
    }

    // Update BearerTokenAuthenticationEnabled if changed. Same pattern
    // as DeletionProtectionEnabled: use !== undefined so explicit
    // `false` reaches AWS.
    if (
      properties['BearerTokenAuthenticationEnabled'] !==
      previousProperties['BearerTokenAuthenticationEnabled']
    ) {
      const next = properties['BearerTokenAuthenticationEnabled'];
      if (next !== undefined) {
        await this.logsClient.send(
          new PutBearerTokenAuthenticationCommand({
            logGroupIdentifier: physicalId,
            bearerTokenAuthenticationEnabled: next as boolean,
          })
        );
      } else {
        // State went from set -> undefined. AWS-side default is false.
        await this.logsClient.send(
          new PutBearerTokenAuthenticationCommand({
            logGroupIdentifier: physicalId,
            bearerTokenAuthenticationEnabled: false,
          })
        );
      }
    }

    // Update FieldIndexPolicies if changed. AWS keys the index policy by
    // logGroupIdentifier alone (one log-group-level policy max), so the
    // diff is structurally trivial: same content -> no-op; new content
    // -> Put (replaces the old one); empty -> Delete.
    const newFieldIndex = properties['FieldIndexPolicies'] as unknown[] | undefined;
    const oldFieldIndex = previousProperties['FieldIndexPolicies'] as unknown[] | undefined;
    if (JSON.stringify(newFieldIndex) !== JSON.stringify(oldFieldIndex)) {
      if (newFieldIndex && newFieldIndex.length > 0) {
        if (newFieldIndex.length > 1) {
          this.logger.debug(
            `Log group ${physicalId} declares ${newFieldIndex.length} FieldIndexPolicies; AWS only supports one log-group-level field index policy. Applying the first.`
          );
        }
        const first = newFieldIndex[0];
        const policyDocument = typeof first === 'string' ? first : JSON.stringify(first);
        await this.logsClient.send(
          new PutIndexPolicyCommand({
            logGroupIdentifier: physicalId,
            policyDocument,
          })
        );
      } else {
        // Removed -> delete the log-group-level policy. The account-level
        // policy (if any) takes over.
        try {
          await this.logsClient.send(
            new DeleteIndexPolicyCommand({ logGroupIdentifier: physicalId })
          );
        } catch (err) {
          if (!(err instanceof ResourceNotFoundException)) throw err;
          // Already absent; treat as success.
        }
      }
    }

    // Update Tags if changed
    const newTags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    const oldTags = previousProperties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
      const arn = await this.buildArn(physicalId);
      // Remove old tags
      if (oldTags && oldTags.length > 0) {
        const oldTagKeys = oldTags.map((t) => t.Key);
        await this.logsClient.send(
          new UntagResourceCommand({
            resourceArn: arn,
            tagKeys: oldTagKeys,
          })
        );
      }
      // Apply new tags
      if (newTags && newTags.length > 0) {
        const tagsMap = Object.fromEntries(newTags.map((t) => [t.Key, t.Value]));
        await this.logsClient.send(
          new TagResourceCommand({
            resourceArn: arn,
            tags: tagsMap,
          })
        );
      }
      this.logger.debug(`Updated tags for log group ${physicalId}`);
    }

    const arn = await this.buildArn(physicalId);

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: arn,
      },
    };
  }

  /**
   * Delete a CloudWatch Logs log group
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting log group ${logicalId}: ${physicalId}`);

    // `--remove-protection`: flip DeletionProtectionEnabled off before
    // delete. Idempotent — AWS accepts the call when protection is
    // already disabled. Non-fatal: log at debug if the flip-off itself
    // errors (NotFound / similar) so the actual delete attempt still
    // runs and surfaces its own error message.
    if (context?.removeProtection === true) {
      try {
        await this.logsClient.send(
          new PutLogGroupDeletionProtectionCommand({
            logGroupIdentifier: physicalId,
            deletionProtectionEnabled: false,
          })
        );
        this.logger.debug(
          `Disabled DeletionProtectionEnabled on log group ${logicalId} before delete`
        );
      } catch (flipError) {
        this.logger.debug(
          `Could not disable DeletionProtectionEnabled on ${physicalId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
        );
      }
    }

    try {
      await this.logsClient.send(new DeleteLogGroupCommand({ logGroupName: physicalId }));
      this.logger.debug(`Successfully deleted log group ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.logsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Log group ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete log group ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Build log group ARN from name
   */
  private async buildArn(logGroupName: string): Promise<string> {
    try {
      const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
      const accountId = identity.Account;
      // Region comes from the client config
      const region =
        (await this.logsClient.config.region()) || process.env['AWS_REGION'] || 'us-east-1';
      return `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}:*`;
    } catch {
      // Fallback: return a placeholder ARN
      return `arn:aws:logs:unknown:unknown:log-group:${logGroupName}:*`;
    }
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing log group.
   *
   * CloudFormation's `AWS::Logs::LogGroup` exposes only `Arn`. The ARN is
   * derivable from the log group name + account + region via the existing
   * `buildArn` helper. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loggroup.html#aws-resource-logs-loggroup-return-values
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName !== 'Arn') {
      return undefined;
    }
    return this.buildArn(physicalId);
  }

  /**
   * Read the AWS-current log group configuration in CFn-property shape.
   *
   * Issues `DescribeLogGroups` filtered by exact name and picks the first
   * (and only) match. AWS uses camelCase field names in the API response
   * (`logGroupName`, `kmsKeyId`, `retentionInDays`); we map them back to
   * the CFn-cased keys cdkd state holds (`LogGroupName`, `KmsKeyId`,
   * `RetentionInDays`).
   *
   * Coverage: `LogGroupName`, `KmsKeyId`, `RetentionInDays`,
   * `LogGroupClass`, `Tags`, `DataProtectionPolicy` (via
   * `GetDataProtectionPolicy`, JSON-parsed back to the object form
   * cdkd state holds), `DeletionProtectionEnabled` and
   * `BearerTokenAuthenticationEnabled` (both surfaced directly from
   * `DescribeLogGroups` — the SDK's LogGroup type carries them as
   * `deletionProtectionEnabled` / `bearerTokenAuthenticationEnabled`),
   * and `FieldIndexPolicies` (via `DescribeIndexPolicies`, filtered to
   * log-group-level policies and JSON-parsed). Still out of scope:
   * `ResourcePolicyDocument` (managed by the separate
   * `AWS::Logs::ResourcePolicy` resource type — account-wide, not
   * per-log-group).
   *
   * Write-side coverage: `FieldIndexPolicies` is applied via
   * `PutIndexPolicy` (CloudWatch Logs allows at most one log-group-level
   * field index policy at a time, so the CFn array is effectively 0-or-1
   * — the first entry is applied and a debug log notes any additional
   * entries are ignored). `DeletionProtectionEnabled` is forwarded as
   * part of `CreateLogGroup` and updated via
   * `PutLogGroupDeletionProtection`. `BearerTokenAuthenticationEnabled`
   * is applied via `PutBearerTokenAuthentication` after the log group
   * exists (it is not part of `CreateLogGroupRequest`).
   *
   * Tags are read via `ListTagsForResource` (using the log-group ARN from
   * the same `DescribeLogGroups` response). CDK's `aws:*` auto-tags are
   * filtered out so they don't fire false-positive drift; the result key is
   * omitted entirely when AWS reports no user tags.
   *
   * Returns `undefined` when the log group is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.logsClient.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: physicalId })
      );
      // logGroupNamePrefix is a prefix match; pick the exact match if any.
      const found = resp.logGroups?.find((g) => g.logGroupName === physicalId);
      if (!found) return undefined;

      const result: Record<string, unknown> = {};
      if (found.logGroupName !== undefined) result['LogGroupName'] = found.logGroupName;
      result['KmsKeyId'] = found.kmsKeyId ?? '';
      // Always-emit per docs/provider-development.md § 3b: a console-side
      // attach of a retention policy on a previously-unbounded log group
      // must surface as drift. `0` is the semantic "never expire"
      // placeholder — it maps to `DeleteRetentionPolicyCommand` in
      // update()'s truthy gate, so the round-trip is a no-op when state
      // and AWS both have no retention.
      result['RetentionInDays'] = found.retentionInDays ?? 0;
      if (found.logGroupClass !== undefined) result['LogGroupClass'] = found.logGroupClass;
      // DeletionProtectionEnabled / BearerTokenAuthenticationEnabled —
      // both are returned directly by DescribeLogGroups. Always-emit
      // false placeholder for console-side toggle detection.
      result['DeletionProtectionEnabled'] = found.deletionProtectionEnabled ?? false;
      result['BearerTokenAuthenticationEnabled'] = found.bearerTokenAuthenticationEnabled ?? false;

      // Tags via ListTagsForResource. Logs ARNs include a trailing ":*"
      // wildcard that ListTagsForResource rejects — strip it.
      let tags: Array<{ Key: string; Value: string }> = [];
      if (found.arn) {
        const arnForTags = found.arn.replace(/:\*$/, '');
        try {
          const tagsResp = await this.logsClient.send(
            new ListTagsForResourceCommand({ resourceArn: arnForTags })
          );
          tags = normalizeAwsTagsToCfn(tagsResp.tags);
        } catch (err) {
          if (err instanceof ResourceNotFoundException) return undefined;
          throw err;
        }
      }
      // Always-emit: a console-side tag add on an initially-untagged log
      // group must surface as drift (state=[] vs AWS=[{...}]).
      result['Tags'] = tags;

      // DataProtectionPolicy via GetDataProtectionPolicy. AWS returns the
      // policy as a JSON string; we re-parse so the comparator matches
      // cdkd state's already-resolved object form. Always-emit `''` when
      // no policy is configured so a console-side ADD is detectable on
      // the v3 observedProperties baseline. (The empty string round-trips
      // through update()'s truthy gate as DeleteDataProtectionPolicy.)
      let dpp: unknown = '';
      try {
        const dppResp = await this.logsClient.send(
          new GetDataProtectionPolicyCommand({ logGroupIdentifier: physicalId })
        );
        if (dppResp.policyDocument) {
          try {
            dpp = JSON.parse(dppResp.policyDocument);
          } catch {
            dpp = dppResp.policyDocument;
          }
        }
      } catch {
        // Best-effort — leave the empty placeholder.
      }
      result['DataProtectionPolicy'] = dpp;

      // FieldIndexPolicies via DescribeIndexPolicies. AWS returns
      // IndexPolicy[] where each entry has policyDocument (JSON string)
      // + source ('LOG_GROUP' / 'ACCOUNT'). We filter to log-group-level
      // policies (excluding inherited account-level policies) and parse
      // the JSON document so the comparator matches cdkd state's
      // already-resolved object form. CFn shape is an array of policy
      // documents (strings or objects). Always-emit [] for console-
      // side ADD detection.
      let fieldIndexPolicies: unknown[] = [];
      try {
        const idxResp = await this.logsClient.send(
          new DescribeIndexPoliciesCommand({ logGroupIdentifiers: [physicalId] })
        );
        const logGroupLevel = (idxResp.indexPolicies ?? []).filter((p) => p.source !== 'ACCOUNT');
        fieldIndexPolicies = logGroupLevel
          .map((p): unknown => {
            if (!p.policyDocument) return undefined;
            try {
              return JSON.parse(p.policyDocument) as unknown;
            } catch {
              return p.policyDocument;
            }
          })
          .filter((p): p is unknown => p !== undefined);
      } catch {
        // Best-effort.
      }
      result['FieldIndexPolicies'] = fieldIndexPolicies;

      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * Adopt an existing CloudWatch Logs log group into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.LogGroupName` → verify via
   *     `DescribeLogGroups` (filtered by name prefix).
   *  2. `aws:cdk:path` tag match via `DescribeLogGroups` + `ListTagsForResource`.
   *
   * `ListTagsForResource` for log groups uses the log-group ARN. The
   * `DescribeLogGroups` response includes the ARN, so no extra round-trip
   * is needed beyond the per-group tag lookup.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'LogGroupName');
    if (explicit) {
      try {
        const resp = await this.logsClient.send(
          new DescribeLogGroupsCommand({ logGroupNamePrefix: explicit })
        );
        const found = resp.logGroups?.find((g) => g.logGroupName === explicit);
        return found ? { physicalId: explicit, attributes: {} } : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.logsClient.send(
        new DescribeLogGroupsCommand({ ...(nextToken && { nextToken }) })
      );
      for (const g of list.logGroups ?? []) {
        if (!g.logGroupName || !g.arn) continue;
        // ListTagsForResource expects an ARN without the trailing ":*" CloudWatch
        // appends to log-group ARNs in API responses. Strip it before the call.
        const arnForTags = g.arn.replace(/:\*$/, '');
        try {
          const tagsResp = await this.logsClient.send(
            new ListTagsForResourceCommand({ resourceArn: arnForTags })
          );
          if (tagsResp.tags?.['aws:cdk:path'] === input.cdkPath) {
            return { physicalId: g.logGroupName, attributes: {} };
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundException) continue;
          throw err;
        }
      }
      nextToken = list.nextToken;
    } while (nextToken);
    return null;
  }
}
