/**
 * go-to-k/cdkd#6418: the sibling context for the deploy-time
 * `observedProperties` capture of an `AWS::EC2::SecurityGroup`, so the rules a
 * standalone `AWS::EC2::SecurityGroupIngress` / `SecurityGroupEgress` of the
 * stack authorizes on the group stay out of its captured inline lists
 * (`provisioning/sg-sibling-rules.ts` is the filter the provider's readback
 * applies to this context).
 *
 * Two sources, both needed:
 * - the stack's RECORDED rule records naming the group: on an UPDATE capture
 *   they exist and their rules are live; one this deploy replaces or removes
 *   still holds its rule until its own operation runs, which the capture can
 *   precede;
 * - the TEMPLATE's rule resources naming the group (`Ref` or
 *   `Fn::GetAtt [<group>, GroupId]`), resolved: a rule created in this deploy
 *   depends on the group and is dispatched the moment it settles, so its
 *   authorize RACES the capture's read, as an `AWS::IAM::Policy` races its
 *   principal's (`buildObservedCaptureSiblings`). A rule whose properties do
 *   not resolve yet (its peer group not created) is skipped: it cannot have
 *   been authorized either.
 *
 * Returns `undefined` when neither source names the group, which leaves the
 * capture as before.
 */
import type { CloudFormationTemplate, ReadCurrentStateContext } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import type { ObservedCaptureSiblingsDeps } from './observed-capture.js';

const RULE_TYPES: ReadonlySet<string> = new Set([
  'AWS::EC2::SecurityGroupIngress',
  'AWS::EC2::SecurityGroupEgress',
]);

/** The rule keys `sgRuleOwnershipIdentity` reads, both directions. */
const IDENTITY_KEYS = [
  'IpProtocol',
  'FromPort',
  'ToPort',
  'CidrIp',
  'CidrIpv6',
  'SourceSecurityGroupId',
  'SourceSecurityGroupName',
  'SourcePrefixListId',
  'DestinationSecurityGroupId',
  'DestinationPrefixListId',
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Does a template `GroupId` name the captured group? */
function namesGroup(groupId: unknown, logicalId: string, physicalId: string): boolean {
  if (groupId === physicalId) return true;
  if (!isPlainRecord(groupId)) return false;
  if (groupId['Ref'] === logicalId) return true;
  const getAtt = groupId['Fn::GetAtt'];
  return Array.isArray(getAtt) && getAtt[0] === logicalId && getAtt[1] === 'GroupId';
}

export async function buildSgRuleCaptureSiblings(
  deps: ObservedCaptureSiblingsDeps,
  capturedLogicalId: string,
  capturedPhysicalId: string,
  template: CloudFormationTemplate | undefined,
  stateResources: Record<string, ResourceState>,
  stackName: string,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>
): Promise<ReadCurrentStateContext | undefined> {
  const siblings: NonNullable<ReadCurrentStateContext['siblings']> = {};
  for (const [lid, rec] of Object.entries(stateResources)) {
    if (lid === capturedLogicalId || !RULE_TYPES.has(rec?.resourceType)) continue;
    if (!isPlainRecord(rec.properties) || rec.properties['GroupId'] !== capturedPhysicalId)
      continue;
    siblings[lid] = { resourceType: rec.resourceType, properties: rec.properties };
  }

  let resolverContext: ReturnType<ObservedCaptureSiblingsDeps['buildResolverContext']> | undefined;
  for (const [lid, res] of Object.entries(template?.Resources ?? {})) {
    if (lid === capturedLogicalId || !RULE_TYPES.has(res.Type)) continue;
    if (
      conditions !== undefined &&
      res.Condition !== undefined &&
      conditions[res.Condition] === false
    ) {
      continue;
    }
    const props = res.Properties;
    if (
      !isPlainRecord(props) ||
      !namesGroup(props['GroupId'], capturedLogicalId, capturedPhysicalId)
    ) {
      continue;
    }
    resolverContext ??= deps.buildResolverContext(
      {
        template: template!,
        resources: stateResources,
        ...(parameterValues && { parameters: parameterValues }),
        ...(conditions && { conditions }),
      },
      stackName
    );
    let resolved: unknown;
    try {
      // Only the keys a rule's identity reads: a `Description` may hold a secret
      // reference, which nothing here needs fetched or held in plaintext.
      const identity = Object.fromEntries(
        IDENTITY_KEYS.filter((key) => props[key] !== undefined).map((key) => [key, props[key]])
      );
      resolved = await deps.resolver.resolve(identity, resolverContext);
    } catch {
      continue;
    }
    if (!isPlainRecord(resolved)) continue;
    // The recorded record (above) keeps its own key: until this deploy's
    // operation on it runs, the rule it RECORDS is the one live.
    const key = siblings[lid] === undefined ? lid : `${lid}#template`;
    siblings[key] = {
      resourceType: res.Type,
      properties: { ...resolved, GroupId: capturedPhysicalId },
    };
  }
  return Object.keys(siblings).length > 0 ? { siblings } : undefined;
}
