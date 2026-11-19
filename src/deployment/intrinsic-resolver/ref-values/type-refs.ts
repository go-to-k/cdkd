/**
 * Per-type `Ref` helpers split out of `ref-values.ts` (the src file-size cap),
 * which re-exports every symbol here.
 */
import { carriesSecretMask } from '../../secret-redaction.js';
import { COMPOSITE_ID_SEPARATOR, segmentAfterAnchor } from '../../../provisioning/composite-id.js';
import type { RefStateLookup } from '../ref-values.js';

/**
 * The `Ref` value of an `AWS::S3Tables::Table` — its TableARN, the value
 * CloudFormation returns (measured with a CloudFormation stack, us-east-1,
 * 2026-10-26: `Ref` equals `Fn::GetAtt TableARN` and stays unchanged across a
 * `TableName` and a `Namespace` change; issue #5316).
 *
 * - A pipe-free physical id IS the TableARN: Cloud Control's primaryIdentifier
 *   for the type is the bare `TableARN`, so a #614-routed table (IcebergMetadata
 *   and friends) records it, as does `S3TablesProvider.importTable` for one.
 *   Returned as is, without reading state.
 * - cdkd's SDK composite `<tableBucketARN>|<namespace>|<tableName>` holds no
 *   segment of the ARN (it ends in a table id AWS mints), so the ARN comes from
 *   the `TableARN` attribute every SDK create (since go-to-k/cdkd#739) and
 *   every import records. A recorded value that is not an ARN, or carries a
 *   `|`, is not used. A record with NO `TableARN` (a table created before
 *   #739) does not reach here from the deploy-time resolver: `resolveRef`
 *   reads it as `Fn::GetAtt TableARN`, whose healer re-reads it from AWS.
 * - Otherwise a record with no usable `TableARN` falls back to the raw
 *   composite id, as the `ref-values.ts`'s `REF_RETURNS_ARN_FROM_STATE` types do, never to
 *   the table name: a name is no value CloudFormation's `Ref` returns, and it
 *   would pass every reader that rejects the composite.
 *
 * A MASKED `TableARN` follows the Glue rule (`ref-values.ts`'s `glueTableRefFromPhysicalId`):
 * a caller with a redaction bag gets the redacted read reported, one without
 * gets the mask back.
 */
export function s3TablesTableRefFromPhysicalId(
  physicalId: string,
  stateLookup?: RefStateLookup
): string {
  if (!physicalId.includes(COMPOSITE_ID_SEPARATOR) || !stateLookup) return physicalId;
  const tableArn = stateLookup(['TableARN']);
  if (tableArn === undefined) return physicalId;
  if (carriesSecretMask(tableArn)) return tableArn;
  return tableArn.startsWith('arn:') && !tableArn.includes(COMPOSITE_ID_SEPARATOR)
    ? tableArn
    : physicalId;
}

/**
 * Is `resource` an SDK-routed `AWS::S3Tables::Table` (its physical id the
 * `<tableBucketARN>|<namespace>|<name>` composite) with no USABLE `TableARN`
 * recorded in either bag (go-to-k/cdkd#5316)? Usable is what
 * {@link s3TablesTableRefFromPhysicalId} would serve: a pipe-free `arn:`
 * string. A masked value counts as recorded, so it keeps that helper's
 * redaction handling.
 */
export function lacksRecordedTableArn(resource: {
  resourceType: string;
  physicalId: string;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}): boolean {
  if (resource.resourceType !== 'AWS::S3Tables::Table') return false;
  if (!resource.physicalId.includes(COMPOSITE_ID_SEPARATOR)) return false;
  const recorded = (bag: Record<string, unknown> | undefined): boolean => {
    if (bag === undefined || !Object.hasOwn(bag, 'TableARN')) return false;
    const value = bag['TableARN'];
    return (
      typeof value === 'string' &&
      (carriesSecretMask(value) ||
        (value.startsWith('arn:') && !value.includes(COMPOSITE_ID_SEPARATOR)))
    );
  };
  return !recorded(resource.properties) && !recorded(resource.attributes);
}

/**
 * CloudFormation's `Ref` for an `AWS::S3Tables::Namespace`: the whole
 * `<tableBucketARN>|<namespace>` (measured, issue #6243), which is the SDK
 * provider's physical id as stored. A Cloud Control physical id joins the
 * schema's `primaryIdentifier` order, `<namespace>|<tableBucketARN>`, so it is
 * reordered. Anything else passes through.
 */
export function s3TablesNamespaceRefFromPhysicalId(physicalId: string): string {
  const parts = physicalId.split(COMPOSITE_ID_SEPARATOR);
  if (parts.length !== 2) return physicalId;
  const [first, second] = parts as [string, string];
  if (!first.startsWith('arn:') && second.startsWith('arn:') && first !== '') {
    return `${second}${COMPOSITE_ID_SEPARATOR}${first}`;
  }
  return physicalId;
}

/**
 * CloudFormation's `Ref` for an `AWS::EC2::VPCGatewayAttachment`:
 * `<AttachmentType>|<VpcId>`, `IGW` or `VGW` (measured for both gateway
 * kinds, issue #6243), while the SDK provider stores `<gatewayId>|<vpcId>`. A
 * Cloud Control id already has CloudFormation's shape and passes through, as
 * does anything that is not an `igw-` / `vgw-` composite.
 */
export function vpcGatewayAttachmentRefFromPhysicalId(physicalId: string): string {
  const parts = physicalId.split(COMPOSITE_ID_SEPARATOR);
  if (parts.length !== 2) return physicalId;
  const [gatewayId, vpcId] = parts as [string, string];
  if (!vpcId.startsWith('vpc-')) return physicalId;
  if (gatewayId.startsWith('igw-')) return `IGW${COMPOSITE_ID_SEPARATOR}${vpcId}`;
  if (gatewayId.startsWith('vgw-')) return `VGW${COMPOSITE_ID_SEPARATOR}${vpcId}`;
  return physicalId;
}

/**
 * CloudFormation's `Ref` for an `AWS::EC2::TransitGatewayRouteTablePropagation`:
 * `<attachmentId>_<routeTableId>` (measured, issue #6612), while Cloud Control's
 * id joins the schema order, `<routeTableId>|<attachmentId>`. Only that exact
 * `tgw-rtb-…|tgw-attach-…` shape is rewritten; anything else passes through.
 */
export function tgwRouteTablePropagationRefFromPhysicalId(physicalId: string): string {
  const parts = physicalId.split(COMPOSITE_ID_SEPARATOR);
  if (parts.length !== 2) return physicalId;
  const [routeTableId, attachmentId] = parts as [string, string];
  if (!routeTableId.startsWith('tgw-rtb-') || !attachmentId.startsWith('tgw-attach-')) {
    return physicalId;
  }
  return `${attachmentId}_${routeTableId}`;
}

/**
 * CloudFormation's `Ref` for an `AWS::Glue::Connection`: the connection name
 * (issue #6612). Cloud Control's id is `<CatalogId>|<Name>`, and a connection
 * name may itself contain `|` while a catalog id is a 12-digit account id, so
 * the name is everything after that FIRST segment. The SDK provider stores the
 * bare name, which passes through — anchoring on the account-id shape keeps a
 * bare name containing `|` intact.
 */
export function glueConnectionRefFromPhysicalId(physicalId: string): string {
  const match = /^\d{12}\|(.+)$/s.exec(physicalId);
  return match ? match[1]! : physicalId;
}

/**
 * CloudFormation's `Ref` for an `AWS::AutoScaling::ScheduledAction`: the action
 * name (measured, issue #6612). Cloud Control's id is
 * `<ScheduledActionName>|<AutoScalingGroupName>`, and BOTH names may contain
 * `|`. A two-segment id is exact and reads nothing; a longer one anchors on the
 * recorded `AutoScalingGroupName` when the id ends with it (a masked one is
 * returned as the mask), else takes everything before the FIRST `|`. A
 * pipe-free id passes through.
 */
export function scheduledActionRefFromPhysicalId(
  physicalId: string,
  stateLookup?: RefStateLookup
): string {
  const firstPipe = physicalId.indexOf(COMPOSITE_ID_SEPARATOR);
  if (firstPipe < 0) return physicalId;
  if (physicalId.includes(COMPOSITE_ID_SEPARATOR, firstPipe + 1)) {
    const group = stateLookup?.(['AutoScalingGroupName']);
    // A masked anchor is served as-is, as for a Glue table: its readers
    // recognise the mask, never a guess.
    if (group !== undefined && carriesSecretMask(group)) return group;
    const suffix = `${COMPOSITE_ID_SEPARATOR}${group ?? ''}`;
    if (suffix.length > 1 && physicalId.length > suffix.length && physicalId.endsWith(suffix)) {
      return physicalId.slice(0, physicalId.length - suffix.length);
    }
  }
  return physicalId.slice(0, firstPipe);
}

/**
 * CloudFormation's `Ref` for an `AWS::ApplicationAutoScaling::ScalingPolicy`:
 * the policy ARN (measured, issue #6612), from Cloud Control's
 * `<Arn>|<ScalableDimension>`. The ARN ends in `:policyName/<name>` and a
 * policy name may contain `|` while the dimension (an enum) cannot, so the ARN
 * is everything before the LAST `|`. A pipe-free id passes through.
 */
export function scalingPolicyRefFromPhysicalId(physicalId: string): string {
  const lastPipe = physicalId.lastIndexOf(COMPOSITE_ID_SEPARATOR);
  return lastPipe < 0 ? physicalId : physicalId.slice(0, lastPipe);
}

/**
 * CloudFormation's `Ref` for an `AWS::ElasticBeanstalk::ConfigurationTemplate`
 * / `::ApplicationVersion`: the template name / version label (both measured,
 * issue #6612), from Cloud Control's `<ApplicationName>|<child>`. A two-segment
 * id is exact and reads nothing; a longer one anchors on the recorded
 * `ApplicationName` (a masked one is returned as the mask), else takes
 * everything after the FIRST `|`. A pipe-free id
 * passes through.
 */
export function elasticBeanstalkChildRefFromPhysicalId(
  physicalId: string,
  stateLookup?: RefStateLookup
): string {
  const firstPipe = physicalId.indexOf(COMPOSITE_ID_SEPARATOR);
  if (firstPipe < 0) return physicalId;
  if (physicalId.includes(COMPOSITE_ID_SEPARATOR, firstPipe + 1)) {
    const application = stateLookup?.(['ApplicationName']);
    if (application !== undefined && carriesSecretMask(application)) return application;
    const anchored = segmentAfterAnchor(physicalId, application);
    if (anchored !== undefined) return anchored;
  }
  return physicalId.slice(firstPipe + 1);
}

/**
 * The issue #6612 types whose `Ref` a per-type helper derives from the physical
 * id (and, for an ambiguous id, a recorded anchor). `cfnRefValueFromPhysicalId`
 * consults it; `scripts/gen-ref-segment-coverage.ts` reads it as a mapping table.
 */
export const REF_FROM_PHYSICAL_ID_HELPERS: ReadonlyMap<
  string,
  (physicalId: string, stateLookup?: RefStateLookup) => string
> = new Map<string, (physicalId: string, stateLookup?: RefStateLookup) => string>([
  ['AWS::EC2::TransitGatewayRouteTablePropagation', tgwRouteTablePropagationRefFromPhysicalId],
  ['AWS::Glue::Connection', glueConnectionRefFromPhysicalId],
  ['AWS::AutoScaling::ScheduledAction', scheduledActionRefFromPhysicalId],
  ['AWS::ApplicationAutoScaling::ScalingPolicy', scalingPolicyRefFromPhysicalId],
  ['AWS::ElasticBeanstalk::ConfigurationTemplate', elasticBeanstalkChildRefFromPhysicalId],
  ['AWS::ElasticBeanstalk::ApplicationVersion', elasticBeanstalkChildRefFromPhysicalId],
]);

/**
 * Types whose `Ref` is an ARN recovered from a recorded attribute while their
 * SDK physical id is a bare name or id (issue #6243), with that attribute.
 * Both are `ref-values.ts`'s `REF_RETURNS_ARN_FROM_STATE` entries too; this map is the
 * subset `resolveRef` heals before serving.
 */
export const REF_ARN_ATTRIBUTE_HEALED: ReadonlyMap<string, string> = new Map([
  ['AWS::AppSync::GraphQLApi', 'Arn'],
  ['AWS::S3Vectors::VectorBucket', 'VectorBucketArn'],
]);

/**
 * The attribute to heal when `resource` is a {@link REF_ARN_ATTRIBUTE_HEALED}
 * type whose physical id is not already its ARN and whose record holds no
 * usable one in either bag; `undefined` otherwise. A record imported before
 * `cdkd import` recorded the ARN (issues #3416 / #3694) is the case: without
 * the heal its `Ref` would silently serve the bare name or id; so is a
 * {@link isPlaceholderArn} value, which the heal replaces. A masked value counts
 * as recorded, so the masked-read refusal keeps handling it.
 */
export function lacksRecordedRefArn(resource: {
  resourceType: string;
  physicalId: string;
  properties?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}): string | undefined {
  const attribute = REF_ARN_ATTRIBUTE_HEALED.get(resource.resourceType);
  if (attribute === undefined || resource.physicalId.startsWith('arn:')) return undefined;
  const recorded = (bag: Record<string, unknown> | undefined): boolean => {
    if (bag === undefined || !Object.hasOwn(bag, attribute)) return false;
    const value = bag[attribute];
    return (
      typeof value === 'string' &&
      (carriesSecretMask(value) || (value.startsWith('arn:') && !isPlaceholderArn(value)))
    );
  };
  return recorded(resource.properties) || recorded(resource.attributes) ? undefined : attribute;
}

/**
 * True for an ARN carrying a wildcard in its region or account position — the
 * shape cdkd's AppSync provider recorded before issue #1681. Matched
 * positionally (fields 3 and 4 of `arn:<partition>:<service>:<region>:<account>`)
 * rather than by substring, so a legitimate ARN whose RESOURCE segment contains
 * `*` (an IAM policy resource pattern, an S3 key prefix) is never rejected.
 */
export function isPlaceholderArn(arn: string): boolean {
  const fields = arn.split(':');
  return fields.length >= 5 && (fields[3] === '*' || fields[4] === '*');
}
