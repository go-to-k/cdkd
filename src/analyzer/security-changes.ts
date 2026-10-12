/**
 * The IAM and security-group change classifier behind `broadening`
 * (go-to-k/cdkd#4601): which statements, managed-policy attachments and
 * security-group rules two templates add or remove, whether that broadens
 * permissions, and the table that shows it.
 *
 * It follows the AWS CDK CLI's own classifier (`@aws-cdk/cloudformation-diff`,
 * Apache-2.0: `TemplateDiff.permissionsBroadened`, `IamChanges`,
 * `SecurityGroupChanges`, `formatSecurityChanges`) rule for rule, so a change
 * `cdk deploy --require-approval=broadening` stops for stops cdkd too. It is
 * cdkd's own code: cdkd has no runtime dependency on a CDK library.
 * `tests/unit/analyzer/security-changes-parity.test.ts` runs both over the same
 * templates (the package is a devDependency for that alone) and
 * its last case holds {@link RESOURCE_SCRUTINY} /
 * {@link PROPERTY_SCRUTINY} to the service-spec database they were read from.
 */

import { bold, gray, green, red, yellow } from '../utils/colors.js';

/** A resource type the security diff reads as a whole. */
type ResourceScrutiny =
  | 'IdentityPolicyResource'
  | 'ResourcePolicyResource'
  | 'LambdaPermission'
  | 'IngressRuleResource'
  | 'EgressRuleResource'
  | 'SsoAssignmentResource'
  | 'SsoInstanceACAConfigResource'
  | 'SsoPermissionSet';

/** A property the security diff reads. */
type PropertyScrutiny =
  | 'InlineIdentityPolicies'
  | 'InlineResourcePolicy'
  | 'ManagedPolicies'
  | 'IngressRules'
  | 'EgressRules';

/** `scrutinizable` of each resource type in `@aws-cdk/aws-service-spec` that has one. */
export const RESOURCE_SCRUTINY: Readonly<Record<string, ResourceScrutiny>> = {
  'AWS::Bedrock::KnowledgeBasePolicy': 'ResourcePolicyResource',
  'AWS::Bedrock::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::CloudTrail::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::EC2::SecurityGroupEgress': 'EgressRuleResource',
  'AWS::EC2::SecurityGroupIngress': 'IngressRuleResource',
  'AWS::ECR::RegistryPolicy': 'ResourcePolicyResource',
  'AWS::EventSchemas::RegistryPolicy': 'ResourcePolicyResource',
  'AWS::EventsV2::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::IAM::GroupPolicy': 'IdentityPolicyResource',
  'AWS::IAM::ManagedPolicy': 'IdentityPolicyResource',
  'AWS::IAM::Policy': 'IdentityPolicyResource',
  'AWS::IAM::RolePolicy': 'IdentityPolicyResource',
  'AWS::IAM::UserPolicy': 'IdentityPolicyResource',
  'AWS::IoT::Policy': 'ResourcePolicyResource',
  'AWS::Kinesis::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::Lambda::Permission': 'LambdaPermission',
  'AWS::Lambda::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::Lex::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::Logs::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::MSK::ClusterPolicy': 'ResourcePolicyResource',
  'AWS::MediaPackageV2::ChannelPolicy': 'ResourcePolicyResource',
  'AWS::MediaPackageV2::OriginEndpointPolicy': 'ResourcePolicyResource',
  'AWS::MediaTailor::ChannelPolicy': 'ResourcePolicyResource',
  'AWS::S3::BucketPolicy': 'ResourcePolicyResource',
  'AWS::S3::MultiRegionAccessPointPolicy': 'ResourcePolicyResource',
  'AWS::S3Express::BucketPolicy': 'ResourcePolicyResource',
  'AWS::S3Files::FileSystemPolicy': 'ResourcePolicyResource',
  'AWS::S3ObjectLambda::AccessPointPolicy': 'ResourcePolicyResource',
  'AWS::S3Outposts::BucketPolicy': 'ResourcePolicyResource',
  'AWS::S3Tables::TableBucketPolicy': 'ResourcePolicyResource',
  'AWS::S3Tables::TablePolicy': 'ResourcePolicyResource',
  'AWS::S3Vectors::VectorBucketPolicy': 'ResourcePolicyResource',
  'AWS::SMSVOICE::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::SNS::TopicInlinePolicy': 'ResourcePolicyResource',
  'AWS::SNS::TopicPolicy': 'ResourcePolicyResource',
  'AWS::SQS::QueueInlinePolicy': 'ResourcePolicyResource',
  'AWS::SQS::QueuePolicy': 'ResourcePolicyResource',
  'AWS::SSM::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::SSO::Assignment': 'SsoAssignmentResource',
  'AWS::SSO::InstanceAccessControlAttributeConfiguration': 'SsoInstanceACAConfigResource',
  'AWS::SSO::PermissionSet': 'SsoPermissionSet',
  'AWS::SecretsManager::ResourcePolicy': 'ResourcePolicyResource',
  'AWS::VpcLattice::AuthPolicy': 'ResourcePolicyResource',
  'AWS::VpcLattice::ResourcePolicy': 'ResourcePolicyResource',
};

/**
 * `scrutinizable` of each resource property in `@aws-cdk/aws-service-spec` that
 * has one, per type in the database's property order (the order rows are read).
 */
export const PROPERTY_SCRUTINY: Readonly<
  Record<string, Readonly<Record<string, PropertyScrutiny>>>
> = {
  'AWS::ApiGateway::DomainNameV2': { Policy: 'InlineResourcePolicy' },
  'AWS::ApiGateway::RestApi': { Policy: 'InlineResourcePolicy' },
  'AWS::Backup::BackupVault': { AccessPolicy: 'InlineResourcePolicy' },
  'AWS::Backup::LogicallyAirGappedBackupVault': { AccessPolicy: 'InlineResourcePolicy' },
  'AWS::CodeArtifact::Domain': { PermissionsPolicyDocument: 'InlineResourcePolicy' },
  'AWS::CodeArtifact::Repository': { PermissionsPolicyDocument: 'InlineResourcePolicy' },
  'AWS::EC2::SecurityGroup': {
    SecurityGroupEgress: 'EgressRules',
    SecurityGroupIngress: 'IngressRules',
  },
  'AWS::EC2::VPCEndpoint': { PolicyDocument: 'InlineResourcePolicy' },
  'AWS::ECR::PublicRepository': { RepositoryPolicyText: 'InlineResourcePolicy' },
  'AWS::ECR::Repository': { RepositoryPolicyText: 'InlineResourcePolicy' },
  'AWS::EFS::FileSystem': { FileSystemPolicy: 'InlineResourcePolicy' },
  'AWS::Events::EventBus': { Policy: 'InlineResourcePolicy' },
  'AWS::IAM::Group': { ManagedPolicyArns: 'ManagedPolicies', Policies: 'InlineIdentityPolicies' },
  'AWS::IAM::Role': {
    AssumeRolePolicyDocument: 'InlineResourcePolicy',
    ManagedPolicyArns: 'ManagedPolicies',
    Policies: 'InlineIdentityPolicies',
  },
  'AWS::IAM::User': { ManagedPolicyArns: 'ManagedPolicies', Policies: 'InlineIdentityPolicies' },
  'AWS::KMS::Key': { KeyPolicy: 'InlineResourcePolicy' },
  'AWS::KMS::ReplicaKey': { KeyPolicy: 'InlineResourcePolicy' },
  'AWS::Logs::LogGroup': {
    DataProtectionPolicy: 'InlineResourcePolicy',
    ResourcePolicyDocument: 'InlineResourcePolicy',
  },
  'AWS::MPA::ApprovalTeam': { Policies: 'InlineIdentityPolicies' },
  'AWS::NetworkManager::CoreNetwork': { PolicyDocument: 'InlineResourcePolicy' },
  'AWS::Oam::Sink': { Policy: 'InlineResourcePolicy' },
  'AWS::Omics::SequenceStore': { S3AccessPolicy: 'InlineResourcePolicy' },
  'AWS::RAM::Permission': { PolicyTemplate: 'InlineResourcePolicy' },
  'AWS::Redshift::Cluster': { NamespaceResourcePolicy: 'InlineResourcePolicy' },
  'AWS::RedshiftServerless::Namespace': { NamespaceResourcePolicy: 'InlineResourcePolicy' },
  'AWS::RolesAnywhere::Profile': { ManagedPolicyArns: 'ManagedPolicies' },
  'AWS::S3::AccessPoint': { Policy: 'InlineResourcePolicy' },
  'AWS::S3Express::AccessPoint': { Policy: 'InlineResourcePolicy' },
  'AWS::S3Outposts::AccessPoint': { Policy: 'InlineResourcePolicy' },
  'AWS::SNS::Subscription': {
    RedrivePolicy: 'InlineResourcePolicy',
    ReplayPolicy: 'InlineResourcePolicy',
  },
  'AWS::SNS::Topic': {
    DataProtectionPolicy: 'InlineResourcePolicy',
    ArchivePolicy: 'InlineResourcePolicy',
  },
  'AWS::SQS::Queue': { RedriveAllowPolicy: 'InlineResourcePolicy' },
  'AWS::SSO::PermissionSet': {
    InlinePolicy: 'InlineResourcePolicy',
    ManagedPolicies: 'ManagedPolicies',
  },
  'AWS::SageMaker::ModelPackageGroup': { ModelPackageGroupPolicy: 'InlineResourcePolicy' },
  'AWS::Serverless::Function': { AssumeRolePolicyDocument: 'InlineResourcePolicy' },
};

function resourceScrutiny(type: string): ResourceScrutiny | undefined {
  return Object.hasOwn(RESOURCE_SCRUTINY, type) ? RESOURCE_SCRUTINY[type] : undefined;
}

function propertyScrutinies(type: string): Readonly<Record<string, PropertyScrutiny>> {
  return Object.hasOwn(PROPERTY_SCRUTINY, type) ? (PROPERTY_SCRUTINY[type] ?? {}) : {};
}

/**
 * Is `path` of a `type` resource read by the security diff: the resource is
 * scrutinized as a whole, or the property is.
 */
export function isScrutinizedProperty(type: string, path: string): boolean {
  return resourceScrutiny(type) !== undefined || Object.hasOwn(propertyScrutinies(type), path);
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One resource of a template: what the security diff reads. */
export interface SecurityTemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SecurityTemplate {
  Resources: Record<string, SecurityTemplateResource>;
}

// ---------------------------------------------------------------------------
// Equality

/** Plain structural equality (`fast-deep-equal` over JSON values). */
function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return a !== a && b !== b; // NaN
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bArr = b as unknown[];
    return a.length === bArr.length && a.every((v, i) => strictEqual(v, bArr[i]));
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (k) =>
      Object.hasOwn(b, k) &&
      strictEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/**
 * CloudFormation's equality: a string equals a boolean or number with the same
 * text, and `DependsOn` compares order-free.
 */
function cfnEqual(lvalue: Json, rvalue: Json): boolean {
  if (lvalue === rvalue) return true;
  if (
    ((typeof lvalue === 'string' && typeof rvalue === 'boolean') ||
      (typeof lvalue === 'boolean' && typeof rvalue === 'string')) &&
    lvalue.toString() === rvalue.toString()
  ) {
    return true;
  }
  if (
    (typeof lvalue === 'string' || typeof rvalue === 'string') &&
    Number(lvalue) === Number(rvalue)
  ) {
    return true;
  }
  if (typeof lvalue !== typeof rvalue) return false;
  if (Array.isArray(lvalue) !== Array.isArray(rvalue)) return false;
  if (Array.isArray(lvalue)) {
    if (lvalue.length !== rvalue.length) return false;
    for (let i = 0; i < lvalue.length; i++) {
      if (!cfnEqual(lvalue[i], rvalue[i])) return false;
    }
    return true;
  }
  if (typeof lvalue === 'object') {
    if (lvalue === null || rvalue === null) return false;
    const keys = Object.keys(lvalue);
    if (keys.length !== Object.keys(rvalue).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(rvalue, key)) return false;
      if (key === 'DependsOn') {
        if (!dependsOnEqual(lvalue[key], rvalue[key])) return false;
        continue;
      }
      if (!cfnEqual(lvalue[key], rvalue[key])) return false;
    }
    return true;
  }
  return false;
}

function dependsOnEqual(lvalue: Json, rvalue: Json): boolean {
  if (Array.isArray(lvalue) !== Array.isArray(rvalue)) {
    const array = Array.isArray(lvalue) ? lvalue : rvalue;
    const nonArray = Array.isArray(lvalue) ? rvalue : lvalue;
    return array.length === 1 && cfnEqual(array[0], nonArray);
  }
  if (Array.isArray(lvalue) && Array.isArray(rvalue)) {
    if (lvalue.length !== rvalue.length) return false;
    // As the AWS CDK CLI's loop: each element is compared with the FIRST of
    // `rvalue`, and only a one-element list can differ.
    for (let i = 0; i < lvalue.length; i++) {
      if (!cfnEqual(lvalue[i], rvalue[0]) && lvalue.length === 1) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Template normalization and intrinsic rendering

/** `Fn::GetAtt: 'A.B'` to `['A', 'B']`, a `DependsOn` to a sorted list. In place. */
function normalize(template: Json): void {
  if (typeof template !== 'object' || template === null) return;
  for (const key of Object.keys(template)) {
    if (key === 'Fn::GetAtt' && typeof template[key] === 'string') {
      template[key] = template[key].split('.');
      continue;
    } else if (key === 'DependsOn') {
      if (typeof template[key] === 'string') template[key] = [template[key]];
      else if (Array.isArray(template[key])) {
        template[key] = template[key].sort((x: Json, y: Json) =>
          String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
        );
      }
      continue;
    }
    if (Array.isArray(template[key])) {
      for (const element of template[key]) normalize(element);
    } else {
      normalize(template[key]);
    }
  }
}

function getIntrinsic(x: Json): { fn: string; args: Json } | undefined {
  if (x === undefined || x === null || Array.isArray(x) || typeof x !== 'object') return undefined;
  const keys = Object.keys(x);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'))
    ? { fn: keys[0]!, args: x[keys[0]!] }
    : undefined;
}

function isNoValue(x: Json): boolean {
  const intrinsic = getIntrinsic(x);
  return intrinsic !== undefined && intrinsic.fn === 'Ref' && intrinsic.args === 'AWS::NoValue';
}

/**
 * An intrinsic as text a reader understands: `Ref` and `Fn::GetAtt` as
 * `${Id}` / `${Id.Attr}`, an `Fn::Join` over a literal list joined, anything
 * else as its JSON; `AWS::NoValue` entries dropped.
 */
function renderIntrinsics(x: Json): Json {
  if (Array.isArray(x)) return x.filter((el) => !isNoValue(el)).map(renderIntrinsics);
  if (isNoValue(x)) return undefined;
  const intrinsic = getIntrinsic(x);
  if (intrinsic !== undefined) {
    if (intrinsic.fn === 'Ref') return '${' + intrinsic.args + '}';
    if (intrinsic.fn === 'Fn::GetAtt') {
      return '${' + intrinsic.args[0] + '.' + intrinsic.args[1] + '}';
    }
    if (intrinsic.fn === 'Fn::Join') {
      const [separator, args] = intrinsic.args;
      if (Array.isArray(args)) {
        return args
          .filter((el) => !isNoValue(el))
          .map(renderIntrinsics)
          .join(separator);
      }
      return JSON.stringify({ 'Fn::Join': renderIntrinsics([separator, args]) });
    }
    return JSON.stringify({ [intrinsic.fn]: renderIntrinsics(intrinsic.args) });
  }
  if (typeof x === 'object' && x !== null) {
    const ret: Record<string, Json> = {};
    for (const [key, value] of Object.entries(x)) {
      if (!isNoValue(value)) ret[key] = renderIntrinsics(value);
    }
    return ret;
  }
  return x;
}

// ---------------------------------------------------------------------------
// IAM statements

class Targets {
  readonly values: string[];
  readonly not: boolean;

  constructor(statement: Json, positiveKey: string, negativeKey: string) {
    if (negativeKey in statement) {
      this.values = forceListOfStrings(statement[negativeKey]);
      this.not = true;
    } else {
      this.values = forceListOfStrings(statement[positiveKey]);
      this.not = false;
    }
    this.values.sort();
  }

  get empty(): boolean {
    return this.values.length === 0;
  }

  equal(other: Targets): boolean {
    return this.not === other.not && strictEqual(this.values.sort(), other.values.sort());
  }

  replaceEmpty(replacement: string): void {
    if (this.empty) this.values.push(replacement);
  }

  replaceStar(replacement: string): void {
    for (let i = 0; i < this.values.length; i++) {
      if (this.values[i] === '*') this.values[i] = replacement;
    }
    this.values.sort();
  }

  render(): string {
    return this.not ? this.values.map((s) => `NOT ${s}`).join('\n') : this.values.join('\n');
  }
}

function forceListOfStrings(x: Json): string[] {
  if (typeof x === 'string') return [x];
  if (x === undefined || x === null) return [];
  if (Array.isArray(x)) return x.map((e) => forceListOfStrings(e).join(','));
  if (typeof x === 'object') {
    const ret: string[] = [];
    for (const [key, value] of Object.entries(x)) {
      ret.push(...forceListOfStrings(value).map((s) => `${key}:${s}`));
    }
    return ret;
  }
  return [`${x}`];
}

class Statement {
  readonly sid: string | undefined;
  readonly effect: 'Allow' | 'Deny' | 'Unknown';
  readonly resources: Targets;
  readonly actions: Targets;
  readonly principals: Targets;
  readonly condition: Json;
  readonly serializedIntrinsic: string | undefined;

  constructor(statement: Json) {
    if (typeof statement === 'string') {
      this.sid = undefined;
      this.effect = 'Unknown';
      this.resources = new Targets({}, '', '');
      this.actions = new Targets({}, '', '');
      this.principals = new Targets({}, '', '');
      this.condition = undefined;
      this.serializedIntrinsic = statement;
    } else {
      // The AWS CDK CLI throws here too (`in` on a non-object), and the gate
      // fails closed on it; this message names no value, as one may be secret.
      if (typeof statement !== 'object' || statement === null) {
        throw new Error('An IAM policy statement is neither an object nor a string');
      }
      this.sid = typeof statement.Sid === 'string' ? statement.Sid : undefined;
      this.effect =
        statement.Effect === 'Allow' || statement.Effect === 'Deny' ? statement.Effect : 'Unknown';
      this.resources = new Targets(statement, 'Resource', 'NotResource');
      this.actions = new Targets(statement, 'Action', 'NotAction');
      this.principals = new Targets(statement, 'Principal', 'NotPrincipal');
      this.condition = statement.Condition;
      this.serializedIntrinsic = undefined;
    }
  }

  equal(other: Statement): boolean {
    return (
      this.sid === other.sid &&
      this.effect === other.effect &&
      this.serializedIntrinsic === other.serializedIntrinsic &&
      this.resources.equal(other.resources) &&
      this.actions.equal(other.actions) &&
      this.principals.equal(other.principals) &&
      strictEqual(this.condition, other.condition)
    );
  }

  /** Allow with a `Not*` target, or Deny without one. */
  get isNegativeStatement(): boolean {
    const notTarget = this.actions.not || this.principals.not || this.resources.not;
    return this.effect === 'Allow' ? notTarget : !notTarget;
  }

  render(): string[] {
    return this.serializedIntrinsic
      ? [this.serializedIntrinsic, '', '', this.principals.render(), '']
      : [
          this.resources.render(),
          this.effect,
          this.actions.render(),
          this.principals.render(),
          renderCondition(this.condition),
        ];
  }
}

function parseStatements(x: Json): Statement[] {
  if (x === undefined) x = [];
  if (!Array.isArray(x)) x = [x];
  return x.map((s: Json) => new Statement(s));
}

/** The statement Lambda adds to a function's policy for an `AWS::Lambda::Permission`. */
function parseLambdaPermission(x: Json): Statement {
  const statement: Json = { Effect: 'Allow', Action: x.Action, Resource: x.FunctionName };
  if (x.Principal !== undefined) {
    if (x.Principal === '*') statement.Principal = '*';
    else if (/^\d{12}$/.test(x.Principal)) {
      statement.Principal = { AWS: `arn:aws:iam::${x.Principal}:root` };
    } else statement.Principal = { Service: x.Principal };
  }
  if (x.SourceArn !== undefined) {
    statement.Condition ??= {};
    statement.Condition.ArnLike = { 'AWS:SourceArn': x.SourceArn };
  }
  if (x.SourceAccount !== undefined) {
    statement.Condition ??= {};
    statement.Condition.StringEquals = { 'AWS:SourceAccount': x.SourceAccount };
  }
  if (x.EventSourceToken !== undefined) {
    statement.Condition ??= {};
    statement.Condition.StringEquals = { 'lambda:EventSourceToken': x.EventSourceToken };
  }
  return new Statement(statement);
}

/** The Condition column: the JSON without its outer braces and indent. */
function renderCondition(condition: Json): string {
  if (!condition || Object.keys(condition).length === 0) return '';
  const lines = JSON.stringify(condition, undefined, 2).split('\n');
  return lines
    .slice(1, lines.length - 1)
    .map((s) => s.slice(2))
    .join('\n');
}

function defaultPrincipal(principal: string, statements: Statement[]): Statement[] {
  statements.forEach((s) => s.principals.replaceEmpty(principal));
  statements.forEach((s) => s.principals.replaceStar(principal));
  return statements;
}

function defaultResource(resource: string, statements: Statement[]): Statement[] {
  statements.forEach((s) => s.resources.replaceEmpty(resource));
  statements.forEach((s) => s.resources.replaceStar(resource));
  return statements;
}

class ManagedPolicyAttachment {
  readonly identityArn: string;
  readonly managedPolicyArn: string;

  constructor(identityArn: string, managedPolicyArn: string) {
    this.identityArn = identityArn;
    this.managedPolicyArn = managedPolicyArn;
  }

  equal(other: ManagedPolicyAttachment): boolean {
    return (
      this.identityArn === other.identityArn && this.managedPolicyArn === other.managedPolicyArn
    );
  }
}

/** An IAM Identity Center element, compared field by field. */
class SsoElement {
  readonly fields: Json;

  constructor(fields: Json) {
    this.fields = fields;
  }

  equal(other: SsoElement): boolean {
    return strictEqual(this.fields, other.fields);
  }
}

// ---------------------------------------------------------------------------
// Security groups

type Peer =
  | { kind: 'cidr-ip'; ip: Json }
  | { kind: 'security-group'; securityGroupId: Json }
  | { kind: 'prefix-list'; prefixListId: Json };

class SecurityGroupRule {
  readonly ipProtocol: string;
  readonly fromPort: Json;
  readonly toPort: Json;
  readonly groupId: Json;
  readonly peer: Peer | undefined;

  constructor(rule: Json, groupRef?: string) {
    this.ipProtocol = rule.IpProtocol?.toString() || '*unknown*';
    this.fromPort = rule.FromPort;
    this.toPort = rule.ToPort;
    this.groupId = rule.GroupId || groupRef || '*unknown*';
    this.peer =
      findFirst(rule, ['CidrIp', 'CidrIpv6'], (ip) => ({ kind: 'cidr-ip', ip })) ||
      findFirst(rule, ['DestinationSecurityGroupId', 'SourceSecurityGroupId'], (id) => ({
        kind: 'security-group',
        securityGroupId: id,
      })) ||
      findFirst(rule, ['DestinationPrefixListId', 'SourcePrefixListId'], (id) => ({
        kind: 'prefix-list',
        prefixListId: id,
      }));
  }

  equal(other: SecurityGroupRule): boolean {
    return (
      this.ipProtocol === other.ipProtocol &&
      this.fromPort === other.fromPort &&
      this.toPort === other.toPort &&
      peerEqual(this.peer, other.peer)
    );
  }

  describeProtocol(): string {
    if (this.ipProtocol === '-1') return 'Everything';
    const ipProtocol = this.ipProtocol.toUpperCase();
    if (this.fromPort === -1) return `All ${ipProtocol}`;
    if (this.fromPort === this.toPort) return `${ipProtocol} ${this.fromPort}`;
    return `${ipProtocol} ${this.fromPort}-${this.toPort}`;
  }

  describePeer(): string {
    switch (this.peer?.kind) {
      case 'cidr-ip':
        if (this.peer.ip === '0.0.0.0/0') return 'Everyone (IPv4)';
        if (this.peer.ip === '::/0') return 'Everyone (IPv6)';
        return `${this.peer.ip}`;
      case 'prefix-list':
        return `${this.peer.prefixListId}`;
      case 'security-group':
        return `${this.peer.securityGroupId}`;
      default:
        return '?';
    }
  }
}

function peerEqual(a: Peer | undefined, b: Peer | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'cidr-ip' && b.kind === 'cidr-ip') return a.ip === b.ip;
  if (a.kind === 'security-group' && b.kind === 'security-group') {
    return a.securityGroupId === b.securityGroupId;
  }
  if (a.kind === 'prefix-list' && b.kind === 'prefix-list')
    return a.prefixListId === b.prefixListId;
  return false;
}

function findFirst(obj: Json, keys: string[], fn: (value: Json) => Peer): Peer | undefined {
  for (const key of keys) {
    try {
      if (key in obj) return fn(obj[key]);
    } catch {
      // A value `in` cannot inspect has no peer.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Old/new collections

interface Equatable<T> {
  equal(other: T): boolean;
}

class DiffableCollection<T extends Equatable<T>> {
  readonly additions: T[] = [];
  readonly removals: T[] = [];
  private readonly oldElements: T[] = [];
  private readonly newElements: T[] = [];

  addOld(...elements: T[]): void {
    this.oldElements.push(...elements);
  }

  addNew(...elements: T[]): void {
    this.newElements.push(...elements);
  }

  calculateDiff(): void {
    const contains = (x: T, xs: T[]): boolean => xs.some((y) => y.equal(x));
    this.additions.push(...this.newElements.filter((x) => !contains(x, this.oldElements)));
    this.removals.push(...this.oldElements.filter((x) => !contains(x, this.newElements)));
  }

  get hasChanges(): boolean {
    return this.additions.length + this.removals.length > 0;
  }

  get hasAdditions(): boolean {
    return this.additions.length > 0;
  }
}

// ---------------------------------------------------------------------------
// The template diff

interface ResourceDiff {
  oldValue: SecurityTemplateResource | undefined;
  newValue: SecurityTemplateResource | undefined;
}

interface PropertyChange {
  logicalId: string;
  resourceType: string;
  scrutiny: PropertyScrutiny;
  oldValue: Json;
  newValue: Json;
}

interface ResourceScrutinyChange {
  logicalId: string;
  scrutiny: ResourceScrutiny;
  oldProperties: Json;
  newProperties: Json;
}

/**
 * Did a resource change at all: its type, any property, or any other key, each
 * by CloudFormation's equality. A key absent on both sides is no change.
 */
function resourceDiffers(oldValue: Json, newValue: Json): boolean {
  if (oldValue === undefined || newValue === undefined) return true;
  if (oldValue.Type !== newValue.Type) return true;
  const keyDiffers = (a: Json, b: Json, skip?: string): boolean =>
    [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].some((key) => {
      if (key === skip) return false;
      const x = a?.[key];
      const y = b?.[key];
      return !(x === undefined && y === undefined) && !cfnEqual(x, y);
    });
  return (
    keyDiffers(oldValue.Properties, newValue.Properties) ||
    keyDiffers(oldValue, newValue, 'Properties')
  );
}

/** The IAM and security-group changes between two templates. */
export class SecurityChanges {
  readonly statements = new DiffableCollection<Statement>();
  readonly managedPolicies = new DiffableCollection<ManagedPolicyAttachment>();
  readonly ssoPermissionSets = new DiffableCollection<SsoElement>();
  readonly ssoAssignments = new DiffableCollection<SsoElement>();
  readonly ssoInstanceACAConfigs = new DiffableCollection<SsoElement>();
  readonly ingress = new DiffableCollection<SecurityGroupRule>();
  readonly egress = new DiffableCollection<SecurityGroupRule>();

  /** Normalizes both templates IN PLACE; pass copies. */
  constructor(oldTemplate: SecurityTemplate, newTemplate: SecurityTemplate) {
    normalize(oldTemplate);
    normalize(newTemplate);
    const oldResources = oldTemplate.Resources ?? {};
    const newResources = newTemplate.Resources ?? {};
    const changed: Array<[string, ResourceDiff]> = [];
    for (const id of new Set([...Object.keys(oldResources), ...Object.keys(newResources)])) {
      const oldValue = Object.hasOwn(oldResources, id) ? oldResources[id] : undefined;
      const newValue = Object.hasOwn(newResources, id) ? newResources[id] : undefined;
      if (oldValue === undefined && newValue === undefined) continue;
      if (resourceDiffers(oldValue, newValue)) changed.push([id, { oldValue, newValue }]);
    }
    for (const change of this.propertyChanges(changed)) this.readPropertyChange(change);
    for (const change of this.resourceChanges(changed)) this.readResourceChange(change);
    for (const collection of this.collections()) collection.calculateDiff();
  }

  private collections(): Array<DiffableCollection<never>> {
    return [
      this.statements,
      this.managedPolicies,
      this.ssoPermissionSets,
      this.ssoAssignments,
      this.ssoInstanceACAConfigs,
      this.ingress,
      this.egress,
    ] as unknown as Array<DiffableCollection<never>>;
  }

  private propertyChanges(changed: Array<[string, ResourceDiff]>): PropertyChange[] {
    const ret: PropertyChange[] = [];
    for (const [logicalId, { oldValue, newValue }] of changed) {
      const oldType = oldValue?.Type;
      const newType = newValue?.Type;
      // A type change is read as a resource removal plus an addition below.
      if (oldType !== undefined && newType !== undefined && oldType !== newType) continue;
      const resourceType = oldType ?? newType;
      if (!resourceType) continue;
      for (const [propertyName, scrutiny] of Object.entries(propertyScrutinies(resourceType))) {
        ret.push({
          logicalId,
          resourceType,
          scrutiny,
          oldValue: oldValue?.Properties?.[propertyName],
          newValue: newValue?.Properties?.[propertyName],
        });
      }
    }
    return ret;
  }

  private resourceChanges(changed: Array<[string, ResourceDiff]>): ResourceScrutinyChange[] {
    const ret: ResourceScrutinyChange[] = [];
    for (const [logicalId, { oldValue, newValue }] of changed) {
      const oldType = oldValue?.Type;
      const newType = newValue?.Type;
      const common = {
        logicalId,
        oldProperties: oldValue?.Properties,
        newProperties: newValue?.Properties,
      };
      if (oldType !== undefined && newType !== undefined && oldType !== newType) {
        const oldScrutiny = resourceScrutiny(oldType);
        if (oldScrutiny) ret.push({ ...common, newProperties: undefined, scrutiny: oldScrutiny });
        const newScrutiny = resourceScrutiny(newType);
        if (newScrutiny) ret.push({ ...common, oldProperties: undefined, scrutiny: newScrutiny });
        continue;
      }
      const type = oldType ?? newType;
      const scrutiny = type ? resourceScrutiny(type) : undefined;
      if (scrutiny) ret.push({ ...common, scrutiny });
    }
    return ret;
  }

  /** Statements added that allow, removed that deny, or any attachment / rule added. */
  get permissionsBroadened(): boolean {
    return (
      this.statements.additions.some((s) => !s.isNegativeStatement) ||
      this.statements.removals.some((s) => s.isNegativeStatement) ||
      this.managedPolicies.hasAdditions ||
      this.ssoPermissionSets.hasAdditions ||
      this.ssoAssignments.hasAdditions ||
      this.ssoInstanceACAConfigs.hasAdditions ||
      this.ingress.hasAdditions ||
      this.egress.hasAdditions
    );
  }

  get iamHasChanges(): boolean {
    return (
      this.statements.hasChanges ||
      this.managedPolicies.hasChanges ||
      this.ssoPermissionSets.hasChanges ||
      this.ssoAssignments.hasChanges ||
      this.ssoInstanceACAConfigs.hasChanges
    );
  }

  get securityGroupsHaveChanges(): boolean {
    return this.ingress.hasChanges || this.egress.hasChanges;
  }

  get permissionsAnyChanges(): boolean {
    return this.iamHasChanges || this.securityGroupsHaveChanges;
  }

  private readPropertyChange(change: PropertyChange): void {
    switch (change.scrutiny) {
      case 'InlineIdentityPolicies':
        this.statements.addOld(...readIdentityPolicies(change.oldValue, change.logicalId));
        this.statements.addNew(...readIdentityPolicies(change.newValue, change.logicalId));
        break;
      case 'InlineResourcePolicy':
        if (change.resourceType === 'AWS::SSO::PermissionSet') {
          this.statements.addOld(
            ...readPermissionSetInlinePolicy(change.oldValue, change.logicalId)
          );
          this.statements.addNew(
            ...readPermissionSetInlinePolicy(change.newValue, change.logicalId)
          );
        } else {
          this.statements.addOld(...readResourceStatements(change.oldValue, change.logicalId));
          this.statements.addNew(...readResourceStatements(change.newValue, change.logicalId));
        }
        break;
      case 'ManagedPolicies':
        this.managedPolicies.addOld(...readManagedPolicies(change.oldValue, change.logicalId));
        this.managedPolicies.addNew(...readManagedPolicies(change.newValue, change.logicalId));
        break;
      case 'IngressRules':
        this.ingress.addOld(...readInlineRules(change.oldValue, change.logicalId));
        this.ingress.addNew(...readInlineRules(change.newValue, change.logicalId));
        break;
      case 'EgressRules':
        this.egress.addOld(...readInlineRules(change.oldValue, change.logicalId));
        this.egress.addNew(...readInlineRules(change.newValue, change.logicalId));
        break;
    }
  }

  private readResourceChange(change: ResourceScrutinyChange): void {
    const id = change.logicalId;
    switch (change.scrutiny) {
      case 'IdentityPolicyResource':
        this.statements.addOld(...readIdentityPolicyResource(change.oldProperties));
        this.statements.addNew(...readIdentityPolicyResource(change.newProperties));
        break;
      case 'ResourcePolicyResource':
        this.statements.addOld(...readResourcePolicyResource(change.oldProperties));
        this.statements.addNew(...readResourcePolicyResource(change.newProperties));
        break;
      case 'LambdaPermission':
        this.statements.addOld(...readLambdaStatements(change.oldProperties));
        this.statements.addNew(...readLambdaStatements(change.newProperties));
        break;
      case 'SsoPermissionSet':
        this.ssoPermissionSets.addOld(...readSso(change.oldProperties, id, permissionSetFields));
        this.ssoPermissionSets.addNew(...readSso(change.newProperties, id, permissionSetFields));
        break;
      case 'SsoAssignmentResource':
        this.ssoAssignments.addOld(...readSso(change.oldProperties, id, assignmentFields));
        this.ssoAssignments.addNew(...readSso(change.newProperties, id, assignmentFields));
        break;
      case 'SsoInstanceACAConfigResource':
        this.ssoInstanceACAConfigs.addOld(...readSso(change.oldProperties, id, acaConfigFields));
        this.ssoInstanceACAConfigs.addNew(...readSso(change.newProperties, id, acaConfigFields));
        break;
      case 'IngressRuleResource':
        this.ingress.addOld(...readRuleResource(change.oldProperties));
        this.ingress.addNew(...readRuleResource(change.newProperties));
        break;
      case 'EgressRuleResource':
        this.egress.addOld(...readRuleResource(change.oldProperties));
        this.egress.addNew(...readRuleResource(change.newProperties));
        break;
    }
  }
}

function readIdentityPolicies(policies: Json, logicalId: string): Statement[] {
  if (policies === undefined || !Array.isArray(policies)) return [];
  const appliesToPrincipal = 'AWS:${' + logicalId + '}';
  return policies.flatMap((policy: Json) => {
    // The policy itself may be an intrinsic, like an `Fn::If`.
    const unparsed = policy.PolicyDocument?.Statement ? policy.PolicyDocument.Statement : policy;
    return defaultPrincipal(appliesToPrincipal, parseStatements(renderIntrinsics(unparsed)));
  });
}

/** An `AWS::IAM::Policy`-like resource: its statements, once per attached identity. */
function readIdentityPolicyResource(properties: Json): Statement[] {
  if (properties === undefined) return [];
  properties = renderIntrinsics(properties);
  const principals: Json[] = (properties.Groups || [])
    .concat(properties.Users || [])
    .concat(properties.Roles || []);
  return principals.flatMap((principal) =>
    defaultPrincipal('AWS:' + principal, parseStatements(properties.PolicyDocument.Statement))
  );
}

function readPermissionSetInlinePolicy(policy: Json, logicalId: string): Statement[] {
  if (policy === undefined) return [];
  const statements = parseStatements(renderIntrinsics(policy.Statement));
  defaultResource('${' + logicalId + '.Arn}', statements);
  defaultPrincipal('AWS:${' + logicalId + '}', statements);
  return statements;
}

function readResourceStatements(policy: Json, logicalId: string): Statement[] {
  if (policy === undefined) return [];
  return defaultResource(
    '${' + logicalId + '.Arn}',
    parseStatements(renderIntrinsics(policy.Statement))
  );
}

/** An `AWS::*::{Bucket,Queue,Topic}Policy`-like resource. */
function readResourcePolicyResource(properties: Json): Statement[] {
  if (properties === undefined) return [];
  properties = renderIntrinsics(properties);
  const policyKeys = Object.keys(properties).filter((key) => key.indexOf('Policy') > -1);
  // The key naming what the policy applies to.
  const resourceKeys = Object.keys(properties).filter(
    (key) => !policyKeys.includes(key) && !key.endsWith('Name')
  );
  let resources: Json = resourceKeys.length === 1 ? properties[resourceKeys[0]!] : ['???'];
  if (!Array.isArray(resources)) resources = [resources];
  return (resources as Json[]).flatMap((resource) =>
    defaultResource(resource, parseStatements(properties[policyKeys[0]!].Statement))
  );
}

function readManagedPolicies(policyArns: Json, logicalId: string): ManagedPolicyAttachment[] {
  if (!policyArns) return [];
  const identity = '${' + logicalId + '}';
  const arns = renderIntrinsics(policyArns);
  return typeof arns === 'string'
    ? [new ManagedPolicyAttachment(identity, arns)]
    : arns.map((arn: Json) => new ManagedPolicyAttachment(identity, arn));
}

function readLambdaStatements(properties: Json): Statement[] {
  if (!properties) return [];
  return [parseLambdaPermission(renderIntrinsics(properties))];
}

function readInlineRules(rules: Json, logicalId: string): SecurityGroupRule[] {
  if (!rules || !Array.isArray(rules)) return [];
  const ref = '${' + logicalId + '.GroupId}';
  return rules.flatMap((rule: Json) => {
    const rendered = renderIntrinsics(rule);
    return typeof rendered === 'object' ? [new SecurityGroupRule(rendered, ref)] : [];
  });
}

function readRuleResource(resource: Json): SecurityGroupRule[] {
  if (!resource) return [];
  return [new SecurityGroupRule(renderIntrinsics(resource))];
}

/** Each IAM Identity Center element's fields, in the order its table shows them. */
const permissionSetFields = (p: Json): Record<string, Json> => ({
  name: p.Name,
  ssoInstanceArn: p.InstanceArn,
  ssoCustomerManagedPolicyReferences: p.CustomerManagedPolicyReferences,
  ssoPermissionsBoundary: p.PermissionsBoundary,
});
const assignmentFields = (p: Json): Record<string, Json> => ({
  ssoInstanceArn: p.InstanceArn,
  permissionSetArn: p.PermissionSetArn,
  principalId: p.PrincipalId,
  principalType: p.PrincipalType,
  targetId: p.TargetId,
  targetType: p.TargetType,
});
const acaConfigFields = (p: Json): Record<string, Json> => ({
  ssoInstanceArn: p.InstanceArn,
  accessControlAttributes: p.AccessControlAttributes,
});

function readSso(
  properties: Json,
  logicalId: string,
  fields: (p: Json) => Record<string, Json>
): SsoElement[] {
  if (properties === undefined) return [];
  // `undefined` fields are left out, so an absent one equals a missing one.
  const values = Object.fromEntries(
    Object.entries({
      cfnLogicalId: '${' + logicalId + '}',
      ...fields(renderIntrinsics(properties)),
    }).filter(([, v]) => v !== undefined)
  );
  return [new SsoElement(values)];
}

// ---------------------------------------------------------------------------
// The table

/** Rows sorted by their second column (then `then`), header first. */
function withHeader(
  color: boolean,
  header: string[],
  rows: string[][],
  then: (row: string[]) => number = () => 0
): string[][] {
  rows.sort((a, b) => {
    const keyA = sortKey(a, color);
    const keyB = sortKey(b, color);
    if (keyA < keyB) return -1;
    if (keyB < keyA) return 1;
    return then(a) - then(b);
  });
  return [header, ...rows];
}

/**
 * A row's second column as the AWS CDK CLI compares it: with colors, wrapped
 * in chalk's codes for its sign (reopened around each line break), so a
 * removal (red) sorts before every addition (green) and a separator divides
 * the two even on one resource; without, the plain text.
 */
function sortKey(row: string[], color: boolean): string {
  const open = !color ? '' : row[0] === '-' ? '\u001b[31m' : row[0] === '+' ? '\u001b[32m' : '';
  // chalk leaves an empty string uncolored.
  if (open === '' || row[1] === '') return row[1]!;
  const close = '\u001b[39m';
  return open + row[1]!.replace(/\r?\n/g, (m) => close + m + open) + close;
}

function summarizeStatements(changes: SecurityChanges, color: boolean): string[][] {
  const rows = [
    ...changes.statements.additions.map((s) => ['+', ...s.render()]),
    ...changes.statements.removals.map((s) => ['-', ...s.render()]),
  ];
  return withHeader(color, ['', 'Resource', 'Effect', 'Action', 'Principal', 'Condition'], rows);
}

function summarizeManagedPolicies(changes: SecurityChanges, color: boolean): string[][] {
  const rows = [
    ...changes.managedPolicies.additions.map((a) => ['+', a.identityArn, a.managedPolicyArn]),
    ...changes.managedPolicies.removals.map((a) => ['-', a.identityArn, a.managedPolicyArn]),
  ];
  return withHeader(color, ['', 'Resource', 'Managed Policy ARN'], rows);
}

function ssoRows(
  collection: DiffableCollection<SsoElement>,
  cells: (f: Json) => string[]
): string[][] {
  return [
    ...collection.additions.map((e) => ['+', ...cells(e.fields)]),
    ...collection.removals.map((e) => ['-', ...cells(e.fields)]),
  ];
}

function formatManagedPolicyRef(s: Json): string {
  return `Name: ${s?.Name || ''}, Path: ${s?.Path || ''}`;
}

function summarizeSsoPermissionSets(changes: SecurityChanges, color: boolean): string[][] {
  const boundary = (pb: Json): string => {
    if (pb?.ManagedPolicyArn !== undefined)
      return `ManagedPolicyArn: ${pb?.ManagedPolicyArn || ''}`;
    if (pb?.CustomerManagedPolicyReference !== undefined) {
      return `CustomerManagedPolicyReference: {\n  ${formatManagedPolicyRef(pb?.CustomerManagedPolicyReference)}\n}`;
    }
    return '';
  };
  const rows = ssoRows(changes.ssoPermissionSets, (f) => [
    f.cfnLogicalId || '',
    f.ssoInstanceArn || '',
    f.name || '',
    boundary(f.ssoPermissionsBoundary),
    f.ssoCustomerManagedPolicyReferences?.map(formatManagedPolicyRef).join('\n') || '',
  ]);
  return withHeader(
    color,
    [
      '',
      'Resource',
      'InstanceArn',
      'PermissionSet name',
      'PermissionsBoundary',
      'CustomerManagedPolicyReferences',
    ],
    rows
  );
}

function summarizeSsoInstanceACAConfigs(changes: SecurityChanges, color: boolean): string[][] {
  const attribute = (aca: Json): string =>
    `Key: ${aca?.Key}, Values: [${aca?.Value?.Source.join(', ')}]`;
  const rows = ssoRows(changes.ssoInstanceACAConfigs, (f) => [
    f.cfnLogicalId || '',
    f.ssoInstanceArn || '',
    f.accessControlAttributes?.map(attribute).join('\n') || '',
  ]);
  return withHeader(color, ['', 'Resource', 'InstanceArn', 'AccessControlAttributes'], rows);
}

function summarizeSsoAssignments(changes: SecurityChanges, color: boolean): string[][] {
  const rows = ssoRows(changes.ssoAssignments, (f) => [
    f.cfnLogicalId || '',
    f.ssoInstanceArn || '',
    f.permissionSetArn || '',
    f.principalId || '',
    f.principalType || '',
    f.targetId || '',
    f.targetType || '',
  ]);
  return withHeader(
    color,
    [
      '',
      'Resource',
      'InstanceArn',
      'PermissionSetArn',
      'PrincipalId',
      'PrincipalType',
      'TargetId',
      'TargetType',
    ],
    rows
  );
}

function summarizeSecurityGroups(changes: SecurityChanges, color: boolean): string[][] {
  const render =
    (sign: string, dir: string) =>
    (rule: SecurityGroupRule): string[] => [
      sign,
      `${rule.groupId}`,
      dir,
      rule.describeProtocol(),
      rule.describePeer(),
    ];
  const rows = [
    ...changes.ingress.additions.map(render('+', 'In')),
    ...changes.egress.additions.map(render('+', 'Out')),
    ...changes.ingress.removals.map(render('-', 'In')),
    ...changes.egress.removals.map(render('-', 'Out')),
  ];
  return withHeader(color, ['', 'Group', 'Dir', 'Protocol', 'Peer'], rows, (row) =>
    row[2]!.indexOf('In') > -1 ? 0 : 1
  );
}

/**
 * Terminal columns a line takes (`string-width`): East Asian wide characters
 * and emoji shown as emoji take two, control and combining characters none.
 * A pictograph that displays as text (`©`, `™`) takes one.
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(
    /(?:\p{Regional_Indicator}{2}|\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?)\p{Emoji_Modifier}?)*/gu,
    '  '
  )) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
    if (code >= 0x300 && code <= 0x36f) continue;
    width += isFullwidth(code) ? 2 : 1;
  }
  return width;
}

function isFullwidth(c: number): boolean {
  return (
    c >= 0x1100 &&
    (c <= 0x115f ||
      c === 0x2329 ||
      c === 0x232a ||
      (c >= 0x2e80 && c <= 0x3247 && c !== 0x303f) ||
      (c >= 0x3250 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0xa4c6) ||
      (c >= 0xa960 && c <= 0xa97c) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe10 && c <= 0xfe19) ||
      (c >= 0xfe30 && c <= 0xfe6b) ||
      (c >= 0xff01 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1b000 && c <= 0x1b001) ||
      (c >= 0x1f200 && c <= 0x1f251) ||
      (c >= 0x20000 && c <= 0x3fffd))
  );
}

/**
 * A box-drawn table; the first row is the header. A line separates rows whose
 * second column differs. With colors, an added row (`+`) is green, a removed
 * one (`-`) red, the borders gray; widths are measured before any color.
 *
 * Unlike the AWS CDK CLI's `table`, a combining mark, a control character or a
 * ZWJ emoji is printed as given (it drops the first two and throws on the
 * third); only the width it takes is measured as `string-width` measures it.
 */
function formatTable(cells: string[][], color: boolean): string {
  const paint = (fn: (text: string) => string) => (color ? fn : (text: string) => text);
  const lines = cells.map((row) => row.map((cell) => String(cell).split('\n')));
  const widths = cells[0]!.map((_, i) =>
    Math.max(...lines.map((row) => Math.max(...row[i]!.map(displayWidth))))
  );
  const rule = (left: string, join: string, right: string): string =>
    paint(gray)(left + widths.map((w) => '─'.repeat(w + 2)).join(join) + right);
  const bar = paint(gray)('│');
  const out: string[] = [rule('┌', '┬', '┐')];
  lines.forEach((row, r) => {
    if (r > 0 && (r === 1 || sortKey(cells[r - 1]!, color) !== sortKey(cells[r]!, color))) {
      out.push(rule('├', '┼', '┤'));
    }
    const sign = r === 0 ? '' : cells[r]![0];
    const tint = paint(sign === '+' ? green : sign === '-' ? red : (text: string) => text);
    const height = Math.max(...row.map((cell) => cell.length));
    for (let l = 0; l < height; l++) {
      const cellsOut = row.map((cell, i) => {
        const text = cell[l] ?? '';
        return (
          ' ' + (text === '' ? '' : tint(text)) + ' '.repeat(widths[i]! - displayWidth(text)) + ' '
        );
      });
      out.push(bar + cellsOut.join(bar) + bar);
    }
  });
  out.push(rule('└', '┴', '┘'));
  return out.join('\n');
}

/**
 * The AWS CDK CLI's security table for these changes: IAM statements, managed
 * policies, IAM Identity Center and security-group rules, each as a section,
 * resources named by construct path where `logicalToPath` knows one. Empty when
 * nothing changed. `color` defaults to what chalk decides for stdout, which
 * also decides the row order (see {@link sortKey}).
 */
export function formatSecurityChanges(
  changes: SecurityChanges,
  logicalToPath: Readonly<Record<string, string>> = {},
  color: boolean = stdoutSupportsColor()
): string {
  if (!changes.permissionsAnyChanges) return '';
  const paint = (fn: (text: string) => string) => (color ? fn : (text: string) => text);
  const substitute = (source: string): string =>
    source.replace(/\$\{([^.}]+)(.[^}]+)?\}/gi, (_m, logId: string, suffix?: string) => {
      const path = Object.hasOwn(logicalToPath, logId) ? logicalToPath[logId] : undefined;
      return '${' + ((path && normalizePath(path)) || logId) + (suffix || '') + '}';
    });
  let out = '';
  const section = (title: string): void => {
    out += `${paint(bold)(title)}\n`;
  };
  const table = (rows: string[][]): void => {
    out +=
      formatTable(
        rows.map((row) => row.map(substitute)),
        color
      ) + '\n';
  };
  if (changes.statements.hasChanges) {
    section('IAM Statement Changes');
    table(summarizeStatements(changes, color));
  }
  if (changes.managedPolicies.hasChanges) {
    section('IAM Policy Changes');
    table(summarizeManagedPolicies(changes, color));
  }
  if (
    changes.ssoPermissionSets.hasChanges ||
    changes.ssoInstanceACAConfigs.hasChanges ||
    changes.ssoAssignments.hasChanges
  ) {
    section('IAM Identity Center Changes');
    if (changes.ssoPermissionSets.hasChanges) table(summarizeSsoPermissionSets(changes, color));
    if (changes.ssoInstanceACAConfigs.hasChanges)
      table(summarizeSsoInstanceACAConfigs(changes, color));
    if (changes.ssoAssignments.hasChanges) table(summarizeSsoAssignments(changes, color));
  }
  if (changes.securityGroupsHaveChanges) {
    section('Security Group Changes');
    table(summarizeSecurityGroups(changes, color));
  }
  out += `${paint(yellow)('(NOTE: There may be security-related changes not in this list. See https://github.com/aws/aws-cdk/issues/1299)')}\n`;
  out += '\n';
  return out;
}

/** A construct path without its stack and a trailing `Resource` / `Default`. */
function normalizePath(p: string): string {
  if (p.startsWith('/')) p = p.slice(1);
  let parts = p.split('/');
  if (parts.length > 1) {
    parts = parts.slice(1);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      if (last === 'Resource' || last === 'Default') parts = parts.slice(0, parts.length - 1);
    }
    p = parts.join('/');
  }
  return p;
}

/**
 * Does chalk color stdout: `supports-color` 7's rule at level 1 or above. The
 * table colors only then, as the AWS CDK CLI's does, so a CI log or a pipe gets
 * plain text in plain row order.
 */
export function stdoutSupportsColor(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  isTTY: boolean = process.stdout.isTTY === true,
  platform: string = process.platform
): boolean {
  const terminator = argv.indexOf('--');
  const hasFlag = (flag: string): boolean => {
    const position = argv.indexOf(`--${flag}`);
    return position !== -1 && (terminator === -1 || position < terminator);
  };
  let force: number | undefined;
  if (['no-color', 'no-colors', 'color=false', 'color=never'].some(hasFlag)) force = 0;
  else if (['color', 'colors', 'color=true', 'color=always'].some(hasFlag)) force = 1;
  const forceEnv = env['FORCE_COLOR'];
  if (forceEnv !== undefined) {
    if (forceEnv === 'true') force = 1;
    else if (forceEnv === 'false') force = 0;
    else force = forceEnv.length === 0 ? 1 : Math.min(parseInt(forceEnv, 10), 3);
  }
  if (force === 0) return false;
  if (['color=16m', 'color=full', 'color=truecolor', 'color=256'].some(hasFlag)) return true;
  if (!isTTY && force === undefined) return false;
  const min = force || 0;
  if (env['TERM'] === 'dumb') return min > 0;
  if (platform === 'win32') return true;
  if ('CI' in env) {
    return (
      ['TRAVIS', 'CIRCLECI', 'APPVEYOR', 'GITLAB_CI', 'GITHUB_ACTIONS', 'BUILDKITE'].some(
        (sign) => sign in env
      ) ||
      env['CI_NAME'] === 'codeship' ||
      min > 0
    );
  }
  if ('TEAMCITY_VERSION' in env) {
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env['TEAMCITY_VERSION'] ?? '');
  }
  if (env['COLORTERM'] === 'truecolor') return true;
  if (env['TERM_PROGRAM'] === 'iTerm.app' || env['TERM_PROGRAM'] === 'Apple_Terminal') return true;
  const term = env['TERM'] ?? '';
  if (/-256(color)?$/i.test(term)) return true;
  if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(term)) return true;
  if ('COLORTERM' in env) return true;
  return min > 0;
}
