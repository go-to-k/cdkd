import type { LogsLogGroupProvider } from '../logs-loggroup-provider.js';
import {
  DescribeLogGroupsCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import {
  type ResourceNotFound,
  type ResourceIdentityVerdict,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { ambientRegion } from '../../../utils/stack-aws-scope.js';
import { definedAttributes } from '../../attribute-map.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  LOG_GROUP_TYPE,
  isLogGroupName,
  listedCreationTime,
  logGroupIdentityToken,
  type LogGroupIdentityRead,
} from './shared.js';

// ─── Identity (go-to-k/cdkd#4606) ────────────────────────────────

/**
 * go-to-k/cdkd#4606: whether the log group a failed CREATE journaled is the
 * one the record under the same logical id holds (a fix-forward that
 * created a new one there under another name).
 *
 * Only `AWS::Logs::LogGroup`; both ids must be log group NAMES (the
 * physical id this provider records), else `'unknown'`, and so are two
 * names differing only in case: this check does not decide on CloudWatch
 * Logs' case rules. Equal names are `'same'` without a read: whatever holds
 * the name now is the record's, and deleting by that name would delete it.
 * A log group name is unique per account and region and cannot be changed.
 * After the region check the record's log group must read back (else
 * `'unknown'`); the journaled one is `'same'` when it reads back under the
 * record's ARN, `'different'` under another, and `'different'` when it is
 * not listed: the record's log group answers to its own, other, name. Any
 * other read failure throws, which the caller reads as `'unknown'`.
 */
export async function isSameResource(
  this: LogsLogGroupProvider,
  journaledPhysicalId: string,
  record: { physicalId: string },
  resourceType: string,
  context: { expectedRegion: string }
): Promise<ResourceIdentityVerdict> {
  if (resourceType !== LOG_GROUP_TYPE) return 'unknown';
  if (!isLogGroupName(journaledPhysicalId) || !isLogGroupName(record.physicalId)) {
    return 'unknown';
  }
  if (journaledPhysicalId === record.physicalId) return 'same';
  if (journaledPhysicalId.toLowerCase() === record.physicalId.toLowerCase()) return 'unknown';
  const clientRegion = await this.logsClient.config.region();
  if (clientRegion !== context.expectedRegion) return 'unknown';
  const recordGroup = await this.readIdentityIfExists(record.physicalId);
  if (recordGroup === undefined) return 'unknown';
  const journaledGroup = await this.readIdentityIfExists(journaledPhysicalId);
  if (journaledGroup === undefined) return 'different';
  // Unreachable as 'same' while the names differ beyond case (the ARN ends
  // in the name); kept so the verdict rests on AWS's answer.
  return journaledGroup.arn === recordGroup.arn ? 'same' : 'different';
}

/**
 * go-to-k/cdkd#4655 / #4606: the log group's ARN and creation time,
 * `<logGroupArn>@<creationTime epoch ms>`. The ARN is built from the name,
 * so a log group re-created under the name repeats it; the creation time
 * is what tells the two apart (the `logs-loggroup-fix-forward-orphan`
 * fixture measures the re-create). `CreateLogGroup` answers with neither,
 * so a failed CREATE's token is this read, which the engine makes when it
 * journals the failure; no ordinary deploy pays for it.
 *
 * `undefined` for another type, an id that is not a log group name, a
 * client in another region than `expectedRegion`, and a response without
 * both fields. `RESOURCE_NOT_FOUND` when `DescribeLogGroups` does not list
 * the exact name (or answers `ResourceNotFoundException`); any other
 * failure throws.
 */
export async function resourceIdentity(
  this: LogsLogGroupProvider,
  physicalId: string,
  resourceType: string,
  context: { expectedRegion: string }
): Promise<string | ResourceNotFound | undefined> {
  if (resourceType !== LOG_GROUP_TYPE || !isLogGroupName(physicalId)) return undefined;
  const clientRegion = await this.logsClient.config.region();
  if (clientRegion !== context.expectedRegion) return undefined;
  const group = await this.readIdentityIfExists(physicalId);
  if (group === undefined) return RESOURCE_NOT_FOUND;
  return logGroupIdentityToken(group);
}

/**
 * go-to-k/cdkd#6665: the attributes a create or an in-place update records,
 * from ONE `DescribeLogGroups` of `name`: `Arn` as AWS lists it (the
 * `logGroupArn` with the `:*` suffix CloudFormation's `Arn` carries) and
 * `LogGroupIdentity` ({@link logGroupIdentityToken}). That read replaces the
 * STS `GetCallerIdentity` {@link buildArn} made, so the call count is
 * unchanged. A read that fails or does not list the group (or lists an ARN
 * not ending in the name) falls back to {@link buildArn} with no identity:
 * the record is then deleted by name, as one written before cdkd recorded it.
 */
export async function createdAttributes(
  this: LogsLogGroupProvider,
  name: string
): Promise<Record<string, unknown>> {
  let group: LogGroupIdentityRead | undefined;
  try {
    group = await this.readIdentityIfExists(name);
  } catch (error) {
    this.logger.debug(
      safeMsg`Could not read log group identity after writing it: ${describeAwsFailure(error).summary}`
    );
  }
  const listedArn = group === undefined ? undefined : `${group.arn}:*`;
  const arn =
    listedArn !== undefined && listedArn.endsWith(`:log-group:${name}:*`)
      ? listedArn
      : await this.buildArn(name);
  return {
    Arn: arn,
    ...definedAttributes({
      LogGroupIdentity:
        group !== undefined && listedArn === arn ? logGroupIdentityToken(group) : undefined,
    }),
  };
}

/**
 * The log group's `logGroupArn` and `creationTime` from `DescribeLogGroups`
 * (by prefix, the exact name picked out: the response is ASCII-sorted, so
 * the exact name sorts first among every name it prefixes and one page
 * answers), or `undefined` when the exact name is not listed or AWS answers
 * `ResourceNotFoundException`. Any other failure, a first page without the
 * name that has more pages, and a listed group with no ARN throw: "could
 * not read" never reads as "gone". A `creationTime` that
 * is not a positive integer reads as absent.
 */
export async function readIdentityIfExists(
  this: LogsLogGroupProvider,
  name: string
): Promise<LogGroupIdentityRead | undefined> {
  let found;
  try {
    const response = await this.logsClient.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: name })
    );
    found = response.logGroups?.find((g) => g.logGroupName === name);
    // A later page could still hold the name if AWS ever stopped sorting
    // it first: only a complete answer reads as "not listed".
    if (found === undefined && response.nextToken) {
      throw new Error(
        'CloudWatch Logs did not list the log group on a first page that has more pages'
      );
    }
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return undefined;
    throw error;
  }
  if (found === undefined) return undefined;
  const arn = found.logGroupArn;
  if (typeof arn !== 'string' || arn === '') {
    throw new Error('CloudWatch Logs returned no logGroupArn');
  }
  return {
    arn,
    creationTime: listedCreationTime(found.creationTime),
    deletionProtectionEnabled: found.deletionProtectionEnabled === true,
  };
}

/**
 * Build log group ARN from name.
 *
 * The partition is derived from the region through the same closed mapping
 * `${AWS::Partition}` uses (issue #1815) rather than hardcoded to `aws` —
 * this ARN is recorded into state and served as the log group's `Arn`
 * attribute, so a commercial literal is structurally valid but wrong in
 * `aws-cn` / `aws-us-gov` and nothing downstream rejects it.
 */
export async function buildArn(this: LogsLogGroupProvider, logGroupName: string): Promise<string> {
  try {
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account;
    // Region comes from the client config
    const region = (await this.logsClient.config.region()) || ambientRegion() || 'us-east-1';
    const { partition } = derivePartitionAndUrlSuffix(region);
    return `arn:${partition}:logs:${region}:${accountId}:log-group:${logGroupName}:*`;
  } catch {
    // Fallback: return a placeholder ARN. The region / account segments stay
    // the pre-existing `unknown` sentinels — nothing resolved them.
    //
    // `AWS_REGION` is a BEST-EFFORT hint for the partition, not an
    // authoritative read: this arm is dominated by the STS failure above
    // (the account lookup runs first), so the client's own region is
    // usually still available, and `AWS_REGION` is only the SECOND source
    // in the try arm's chain — the shared `AwsClients` logs client may have
    // been built from an explicit `AwsClientConfig.region` or from the SDK's
    // own chain instead. What it does guarantee is the direction: an unset
    // or unrecognized value derives to the commercial `aws`, so this is
    // byte-identical to the old placeholder wherever it was right, and a
    // non-commercial `AWS_REGION` upgrades it rather than leaving a silent
    // commercial claim.
    const { partition } = derivePartitionAndUrlSuffix(ambientRegion() ?? '');
    return `arn:${partition}:logs:unknown:unknown:log-group:${logGroupName}:*`;
  }
}
