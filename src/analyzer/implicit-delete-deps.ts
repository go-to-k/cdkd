/**
 * Type-based implicit deletion dependency rules.
 *
 * CloudFormation expresses creation order via Ref / Fn::GetAtt / DependsOn.
 * For deletion, AWS additionally enforces ordering rules that aren't visible
 * in those references — for example, an InternetGateway can't be deleted
 * while it's still attached to a VPC, even though the attachment Ref's the
 * IGW (not the other way around). This module centralizes those type-based
 * rules so that both the deploy engine (DELETE phase) and the destroy
 * command apply the same ordering.
 *
 * Each entry maps `KEY` → list of types that must be deleted BEFORE the
 * KEY type. Reading example:
 *
 *   'AWS::EC2::Subnet': ['AWS::Lambda::Function']
 *
 * = "every Subnet in this stack must be deleted AFTER every Lambda in
 *    this stack" — required because Lambda's VpcConfig leaves an ENI in
 *    the subnet for some time after the function is deleted, and tearing
 *    the subnet down first triggers a DependencyViolation.
 */
export const IMPLICIT_DELETE_DEPENDENCIES: Record<string, readonly string[]> = {
  // IGW must be deleted AFTER VPCGatewayAttachment, and AFTER the NAT
  // Gateway. A NAT Gateway holds an Elastic IP mapped to the VPC's public
  // address space; until the NAT is gone (which releases/decouples the EIP),
  // EC2 rejects the IGW detach with `Network vpc-xxx has some mapped public
  // address(es)` and the IGW delete then hangs. CloudFormation enforces this
  // same NAT-before-IGW ordering. (The EIP itself does not need a type-based
  // rule: the NAT Ref's the EIP via `AllocationId`, so the reversed delete
  // traversal already deletes the NAT before the EIP is released.)
  'AWS::EC2::InternetGateway': ['AWS::EC2::VPCGatewayAttachment', 'AWS::EC2::NatGateway'],

  // VPCGatewayAttachment (the IGW<->VPC attachment) must be detached AFTER the
  // NAT Gateway is gone — same `mapped public address(es)` rejection as the IGW
  // delete above (the detach is the operation that actually trips the error).
  'AWS::EC2::VPCGatewayAttachment': ['AWS::EC2::NatGateway'],

  // EventBus must be deleted AFTER Rules on that bus
  'AWS::Events::EventBus': ['AWS::Events::Rule'],

  // Athena workgroup must be deleted AFTER its named queries
  'AWS::Athena::WorkGroup': ['AWS::Athena::NamedQuery'],

  // CloudFront managed-policy-style resources must be deleted AFTER
  // any Distribution that references them
  'AWS::CloudFront::ResponseHeadersPolicy': ['AWS::CloudFront::Distribution'],
  'AWS::CloudFront::CachePolicy': ['AWS::CloudFront::Distribution'],
  'AWS::CloudFront::OriginAccessControl': ['AWS::CloudFront::Distribution'],

  // VPC must be deleted AFTER all VPC-dependent resources
  'AWS::EC2::VPC': [
    'AWS::EC2::Subnet',
    'AWS::EC2::SecurityGroup',
    'AWS::EC2::InternetGateway',
    'AWS::EC2::EgressOnlyInternetGateway',
    'AWS::EC2::VPCGatewayAttachment',
    'AWS::EC2::RouteTable',
  ],

  // Subnet must be deleted AFTER any Lambda that may still hold an ENI
  // in it. Lambda DELETE returns immediately but the ENI is detached
  // asynchronously by AWS, so deleting the Subnet first races the detach
  // and yields "DependencyViolation".
  'AWS::EC2::Subnet': ['AWS::EC2::SubnetRouteTableAssociation', 'AWS::Lambda::Function'],

  // RouteTable must be deleted AFTER Route and Association
  'AWS::EC2::RouteTable': ['AWS::EC2::Route', 'AWS::EC2::SubnetRouteTableAssociation'],

  // SecurityGroup must be deleted AFTER any Lambda whose ENI is bound
  // to it (same ENI-detach race as Subnet above).
  'AWS::EC2::SecurityGroup': [
    'AWS::EC2::SecurityGroupIngress',
    'AWS::EC2::SecurityGroupEgress',
    'AWS::Lambda::Function',
  ],
};

/**
 * The types {@link IMPLICIT_DELETE_DEPENDENCIES} says must be deleted before
 * `type`, read by own key: `type` can come from a state file, and an
 * inherited name (`constructor`) answers none (go-to-k/cdkd#7073).
 */
export function typesDeletedBefore(type: string): readonly string[] {
  return Object.prototype.hasOwnProperty.call(IMPLICIT_DELETE_DEPENDENCIES, type)
    ? IMPLICIT_DELETE_DEPENDENCIES[type]!
    : [];
}

/**
 * A single implicit delete-ordering edge: the resource at `before` (logical id)
 * must finish deleting BEFORE the resource at `after` (logical id).
 *
 * Unlike {@link IMPLICIT_DELETE_DEPENDENCIES} (which expresses ordering between
 * TYPES, so every instance of type X orders against every instance of type Y),
 * these edges are computed per-RESOURCE — they are derived from the actual
 * references one resource carries, so they can express "this specific composite
 * alarm before this specific metric alarm" without forcing an all-pairs rule.
 */
export interface ImplicitDeleteEdge {
  /** Logical id of the resource that must be deleted first. */
  before: string;
  /** Logical id of the resource that must be deleted after `before`. */
  after: string;
}

/**
 * A resource as seen by the delete-ordering computation. Both the deploy DELETE
 * phase (`StackState.resources[id]`) and the standalone destroy command shape
 * carry these fields, so this is the common subset both call sites can pass.
 */
export interface DeleteOrderingResource {
  resourceType: string;
  physicalId?: string;
  properties?: Record<string, unknown>;
  dependencies?: readonly string[];
}

const IAM_ROLE_POLICY_TYPES: ReadonlySet<string> = new Set([
  'AWS::IAM::Policy',
  'AWS::IAM::RolePolicy',
  'AWS::IAM::ManagedPolicy',
]);

function isCustomResourceType(type: string): boolean {
  return type === 'AWS::CloudFormation::CustomResource' || type.startsWith('Custom::');
}

function recordedDependencies(resource: DeleteOrderingResource | undefined): readonly string[] {
  const deps: unknown = resource?.dependencies;
  return Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : [];
}

/**
 * Matches one alarm-state function token in a CompositeAlarm `AlarmRule`:
 *   ALARM("name") | OK('name') | INSUFFICIENT_DATA(name)
 * The argument is captured raw (with any surrounding quotes) and trimmed /
 * unquoted by {@link extractReferencedAlarmNames}. CloudWatch also accepts the
 * boolean literals TRUE / FALSE which carry no argument, so they never match.
 */
const ALARM_RULE_FUNCTION_REGEX = /\b(?:ALARM|OK|INSUFFICIENT_DATA)\s*\(\s*([^)]*?)\s*\)/gi;

/**
 * Extract every alarm NAME (or ARN) referenced by a CompositeAlarm `AlarmRule`
 * string. The rule references its child alarms by NAME (or ARN) as a plain
 * string — there is no `Ref` / `Fn::GetAtt`, so cdkd's DAG sees no dependency
 * edge from these references. We parse them out so a delete-ordering edge can be
 * synthesized (CloudWatch refuses to delete a metric alarm while a composite
 * alarm still references it).
 *
 * Handles the three alarm-state functions (`ALARM` / `OK` / `INSUFFICIENT_DATA`)
 * and both the bare-name and quoted-name forms. An ARN argument
 * (`arn:aws:cloudwatch:...:alarm:<name>`) is reduced to its trailing `<name>`
 * so it can be matched against a referenced alarm's `AlarmName` / physical id
 * the same way a bare name is.
 */
export function extractReferencedAlarmNames(alarmRule: string): string[] {
  const names = new Set<string>();
  for (const match of alarmRule.matchAll(ALARM_RULE_FUNCTION_REGEX)) {
    let arg = (match[1] ?? '').trim();
    if (arg.length === 0) continue;
    // Strip a single pair of surrounding quotes (single or double).
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      arg = arg.slice(1, -1);
    }
    if (arg.length === 0) continue;
    // ARN form: arn:aws:cloudwatch:<region>:<acct>:alarm:<name> — reduce to the
    // trailing name so it matches an AlarmName / physical id.
    const arnAlarmMatch = /:alarm:(.+)$/.exec(arg);
    if (arnAlarmMatch?.[1]) {
      names.add(arnAlarmMatch[1]);
    } else {
      names.add(arg);
    }
  }
  return [...names];
}

/**
 * Compute per-resource delete-ordering edges that cannot be inferred from
 * Ref / Fn::GetAtt edges or from the type-pair {@link IMPLICIT_DELETE_DEPENDENCIES}
 * table.
 *
 * Currently this synthesizes edges for `AWS::CloudWatch::CompositeAlarm`: a
 * composite alarm references its child alarms (metric `AWS::CloudWatch::Alarm`
 * or other composite alarms) by NAME inside its `AlarmRule` string. Because the
 * reference is a plain string (no `Ref` / `Fn::GetAtt`), cdkd's DAG sees no
 * dependency edge, so without this the metric alarm can be scheduled for
 * deletion while the composite still exists — and CloudWatch rejects that with
 * `Cannot delete <alarm> as there are composite alarm(s) depending on it.`
 * We therefore emit an edge making the composite alarm delete BEFORE every
 * alarm its `AlarmRule` references (handling composite-of-composite too).
 *
 * It also deletes a custom resource BEFORE each IAM policy attached to its
 * ServiceToken Lambda's role (go-to-k/cdkd#7208), the delete-side mirror of
 * `DagBuilder`'s custom-resource policy edge: the handler's `Delete` call needs
 * the policy's grants. The recorded `dependencies` carry the chain (custom
 * resource -> Lambda -> role <- policy), since a record's properties hold
 * resolved values and no `Ref`. An edge that would close a cycle is skipped, as
 * `DagBuilder` skips one, so the delete graph stays acyclic.
 *
 * @param resources logical id -> resource (the subset of resources participating
 *   in the delete). Only entries whose logical id is a key in this record are
 *   considered as edge endpoints.
 * @param context every record of the stack, for the custom resource's chain
 *   through records outside `resources` (a Lambda the delete keeps). Defaults to
 *   `resources`.
 */
export function computeImplicitDeleteEdges(
  resources: Record<string, DeleteOrderingResource>,
  context: Record<string, DeleteOrderingResource> = resources
): ImplicitDeleteEdge[] {
  const edges = computeAlarmRuleEdges(resources);
  edges.push(...computeCustomResourcePolicyEdges(resources, context, edges));
  return edges;
}

function computeAlarmRuleEdges(
  resources: Record<string, DeleteOrderingResource>
): ImplicitDeleteEdge[] {
  const edges: ImplicitDeleteEdge[] = [];

  // Index alarm resources (metric + composite) by the name a CompositeAlarm's
  // AlarmRule would reference them by: their AlarmName property if set, else
  // their physical id (CloudWatch alarm physical id IS the alarm name).
  const alarmTypes = new Set(['AWS::CloudWatch::Alarm', 'AWS::CloudWatch::CompositeAlarm']);
  const nameToLogicalId = new Map<string, string>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!alarmTypes.has(resource.resourceType)) continue;
    const alarmName =
      typeof resource.properties?.['AlarmName'] === 'string'
        ? (resource.properties['AlarmName'] as string)
        : resource.physicalId;
    if (alarmName) nameToLogicalId.set(alarmName, logicalId);
  }

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.resourceType !== 'AWS::CloudWatch::CompositeAlarm') continue;
    const alarmRule = resource.properties?.['AlarmRule'];
    if (typeof alarmRule !== 'string') continue;

    for (const referencedName of extractReferencedAlarmNames(alarmRule)) {
      const referencedLogicalId = nameToLogicalId.get(referencedName);
      // Skip names we can't resolve to a same-stack resource and skip a
      // self-reference (a composite alarm cannot reference itself, but guard
      // against it so we never emit a self-cycle).
      if (!referencedLogicalId || referencedLogicalId === logicalId) continue;
      // The composite (logicalId) must be deleted BEFORE the referenced alarm.
      edges.push({ before: logicalId, after: referencedLogicalId });
    }
  }

  return edges;
}

function computeCustomResourcePolicyEdges(
  resources: Record<string, DeleteOrderingResource>,
  context: Record<string, DeleteOrderingResource>,
  existing: readonly ImplicitDeleteEdge[]
): ImplicitDeleteEdge[] {
  const own = (bag: Record<string, DeleteOrderingResource>, id: string) =>
    Object.prototype.hasOwnProperty.call(bag, id) && typeof bag[id] === 'object' && bag[id] !== null
      ? bag[id]
      : undefined;

  // roleId -> the participating policies attached to it.
  const policiesOfRole = new Map<string, string[]>();
  for (const [policyId, policy] of Object.entries(resources)) {
    if (typeof policy !== 'object' || policy === null) continue;
    if (!IAM_ROLE_POLICY_TYPES.has(policy.resourceType)) continue;
    for (const roleId of recordedDependencies(policy)) {
      if (own(context, roleId)?.resourceType !== 'AWS::IAM::Role') continue;
      const list = policiesOfRole.get(roleId) ?? [];
      list.push(policyId);
      policiesOfRole.set(roleId, list);
    }
  }
  // No policy, no work: an ordinary delete pays nothing for this.
  if (policiesOfRole.size === 0) return [];

  const edges: ImplicitDeleteEdge[] = [];
  // Delete-before adjacency over `context`, built on the first candidate.
  let before: Map<string, Set<string>> | undefined;
  const addBefore = (first: string, then: string): void => {
    let set = before!.get(first);
    if (!set) before!.set(first, (set = new Set()));
    set.add(then);
  };
  const buildBefore = (): void => {
    before = new Map();
    const byType = new Map<string, string[]>();
    for (const [id, r] of Object.entries(context)) {
      if (typeof r !== 'object' || r === null) continue;
      // A dependent is deleted before what it depends on.
      for (const dep of recordedDependencies(r)) addBefore(id, dep);
      const ids = byType.get(r.resourceType) ?? [];
      ids.push(id);
      byType.set(r.resourceType, ids);
    }
    for (const [type, ids] of byType) {
      for (const earlierType of typesDeletedBefore(type)) {
        for (const earlier of byType.get(earlierType) ?? []) {
          for (const id of ids) addBefore(earlier, id);
        }
      }
    }
    for (const edge of existing) addBefore(edge.before, edge.after);
  };
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (id === to) return true;
      for (const next of before!.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };

  for (const [crId, cr] of Object.entries(resources)) {
    if (typeof cr !== 'object' || cr === null || !isCustomResourceType(cr.resourceType)) continue;
    for (const lambdaId of recordedDependencies(cr)) {
      const lambda = own(context, lambdaId);
      if (lambda?.resourceType !== 'AWS::Lambda::Function') continue;
      for (const roleId of recordedDependencies(lambda)) {
        for (const policyId of policiesOfRole.get(roleId) ?? []) {
          if (policyId === crId) continue;
          if (before === undefined) buildBefore();
          if (before!.get(crId)?.has(policyId)) continue;
          // The policy already goes before the custom resource: an edge back
          // would close a cycle.
          if (reaches(policyId, crId)) continue;
          addBefore(crId, policyId);
          edges.push({ before: crId, after: policyId });
        }
      }
    }
  }
  return edges;
}
