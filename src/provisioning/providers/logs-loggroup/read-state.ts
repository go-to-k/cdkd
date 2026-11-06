import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import {
  DescribeIndexPoliciesCommand,
  DescribeLogGroupsCommand,
  GetDataProtectionPolicyCommand,
  ListTagsForResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { type ResourceNotFound, RESOURCE_NOT_FOUND } from '../../../types/resource.js';

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
export async function getAttribute(
  this: LogsLogGroupProvider,
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
 * `ResourcePolicyDocument`, which is declared in
 * {@link unhandledByDesign} (issue #1412) — this provider does not own a
 * resource policy, so a log group whose template sets it routes via Cloud
 * Control rather than through this provider at all.
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
 * Returns `RESOURCE_NOT_FOUND` when the log group is gone.
 */
export async function readCurrentState(
  this: LogsLogGroupProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  try {
    const resp = await this.logsClient.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: physicalId })
    );
    // logGroupNamePrefix is a prefix match; pick the exact match if any.
    const found = resp.logGroups?.find((g) => g.logGroupName === physicalId);
    if (!found) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {};
    if (found.logGroupName !== undefined) result['LogGroupName'] = found.logGroupName;
    result['KmsKeyId'] = found.kmsKeyId ?? '';
    // Always-emit per docs/provider-rules.md#readcurrentstate-for-drift-detection: a console-side
    // attach of a retention policy on a previously-unbounded log group
    // must surface as drift. `0` is the semantic "never expire"
    // placeholder — `update()` sends `DeleteRetentionPolicyCommand` for it
    // (its send gate is `retentionInDays !== undefined && > 0` since issue
    // [#2521], where it used to be a bare truthiness test), so the
    // round-trip is a no-op when state and AWS both have no retention.
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
        if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
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
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
}
