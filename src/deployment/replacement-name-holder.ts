/**
 * Who holds a replacement's colliding name. Three questions:
 * {@link replacementRequestsDifferentName} (deploy: a KNOWN different explicit
 * name), and one proof per direction, sharing one rule —
 * {@link reverseReplacementNewHoldsName} (rollback) and
 * {@link replacementOldHoldsSentName} (deploy `--replace`), further down.
 *
 * Does a replacement ask for a physical name the resource being replaced does
 * NOT hold? (issue [#3808](https://github.com/go-to-k/cdkd/issues/3808))
 *
 * The replacement name-collision refusals presume the colliding name is held by
 * the old resource, and prescribe deleting that resource first (`--replace`, or
 * dropping `UpdateReplacePolicy: Retain`). That holds only when the replacement
 * keeps the name. When it CHANGES it — the template's explicit name property now
 * says something the old resource was never called — the holder is some other
 * resource, deleting the old one frees nothing, and the advice ends with the
 * managed resource gone and the same collision.
 *
 * Answers only when the difference is KNOWN; `undefined` otherwise, which keeps
 * the callers' pre-existing wording and behaviour. The asymmetry is deliberate:
 * a positive answer REFUSES the delete-first retry, so it must not fire on a
 * replacement that keeps its name.
 *
 * - The desired name is the TEMPLATE's explicit name property
 *   ({@link explicitNamePropertyFor}). With none, the answer is `undefined`:
 *   a generated name is not compared, so a replacement that DROPS an explicit
 *   name keeps the pre-existing behaviour (go-to-k/cdkd#3931 carries it).
 * - The held name is the state record's recorded, then observed, value of the
 *   OLD type's name property. A recorded value is the TEMPLATE's, which a
 *   provider may normalise before AWS sees it (IAM's `_` to `-`), so a physical
 *   id that names the desired name overrides a differing recorded one.
 * - With no held name, the physical id alone decides, and only when it does
 *   NOT name the desired name: equal, or a final segment after `|`, or after
 *   `:` / `/` in an ARN or a URL (a name-shaped id may contain `/`), or, in a Secrets Manager ARN, that segment plus its
 *   6-character suffix. Anything else — an opaque id like `sg-…` included — counts as
 *   different, which refuses without deleting.
 * - Names compare case-insensitively: several services (IAM among them) treat
 *   two spellings differing only in case as one name. The cost, on a
 *   case-sensitive service, is keeping `--replace` for a case-only rename.
 * - A redacted value ({@link SECRET_MASK}) or an unresolved dynamic reference
 *   (`{{resolve:…}}`, which state keeps as written) is not a name: skipped.
 */

import type { ProvisionedBy } from '../provisioning/provider-registry.js';
import {
  explicitNamePropertyFor,
  generateResourceName,
  generateResourceNameWithFallback,
  getCurrentSkipPrefix,
  withSkipPrefix,
} from '../provisioning/resource-name.js';
import { displayIdent, STACK_REF_MAX_CODE_POINTS } from '../utils/display-safe.js';
import { withDerivedNameMasks } from '../provisioning/masked-retry-logger.js';
import { SECRET_MASK } from './secret-redaction.js';

export interface ReplacementNameChange {
  /** The template's name property, e.g. `FunctionName`. */
  property: string;
  /** The name the replacement asks for. */
  desiredName: string;
  /** The name the old resource holds, when state records it. */
  heldName: string | undefined;
  /** The OLD type's name property `heldName` was read from. */
  heldProperty: string | undefined;
  /** The old resource's physical id. */
  physicalId: string;
}

function nameValue(bag: Record<string, unknown> | undefined, property: string): string | undefined {
  const value = bag?.[property];
  if (typeof value !== 'string' || value === '' || value === SECRET_MASK) return undefined;
  if (value.includes('{{resolve:')) return undefined;
  return value;
}

/** Does `physicalId` name `desired` (both folded alike)? See the module doc. */
function physicalIdNames(physicalId: string, desired: string): boolean {
  if (physicalId === desired) return true;
  // `:` and `/` separate segments only inside an ARN or a URL: a physical id
  // that IS the name may itself contain `/` (`/app/db`, `/aws/lambda/fn`).
  const separators = /^(arn:|https?:\/\/)/.test(physicalId) ? /[:/|]/ : /\|/;
  const cut = physicalId.length - desired.length - 1;
  if (cut >= 0 && physicalId.endsWith(desired) && separators.test(physicalId.charAt(cut))) {
    return true;
  }
  // Secrets Manager's ARN appends `-` and 6 random characters to the name.
  if (!physicalId.includes(':secret:')) return false;
  const last = physicalId.split(':').pop() ?? '';
  return last.length === desired.length + 7 && last.startsWith(`${desired}-`);
}

export function replacementRequestsDifferentName(input: {
  oldResourceType: string;
  newResourceType: string;
  desiredProperties: Record<string, unknown> | undefined;
  recorded: Record<string, unknown> | undefined;
  observed: Record<string, unknown> | undefined;
  physicalId: string;
  /**
   * Compare names EXACTLY (go-to-k/cdkd#3937). Only for a type whose create
   * adopts a taken name ({@link replacementCreateAdoptsName}): there a
   * case-only rename is a different name, and folding it skipped the probe.
   */
  caseSensitive?: boolean;
}): ReplacementNameChange | undefined {
  const property = explicitNamePropertyFor(input.newResourceType);
  if (property === undefined) return undefined;
  const desiredName = nameValue(input.desiredProperties, property);
  if (desiredName === undefined) return undefined;
  const fold =
    input.caseSensitive === true
      ? (v: string): string => v
      : (v: string): string => v.toLowerCase();
  const desired = fold(desiredName);

  const oldProperty = explicitNamePropertyFor(input.oldResourceType);
  const heldName =
    oldProperty === undefined
      ? undefined
      : (nameValue(input.recorded, oldProperty) ?? nameValue(input.observed, oldProperty));

  const physicalId = fold(input.physicalId);
  if (heldName !== undefined && fold(heldName) === desired) return undefined;
  if (heldName === undefined && physicalId === '') return undefined;
  if (physicalId !== '' && physicalIdNames(physicalId, desired)) return undefined;
  return {
    property,
    desiredName,
    heldName,
    heldProperty: heldName === undefined ? undefined : oldProperty,
    physicalId: input.physicalId,
  };
}

/**
 * Types whose SDK create does not refuse a name another resource already
 * holds: it RETURNS that resource (SQS `CreateQueue` with matching attributes,
 * SNS `CreateTopic`, Step Functions `CreateStateMachine` with an identical
 * definition, ECS `CreateCluster` for an ACTIVE cluster — measured — and ELBv2
 * `CreateLoadBalancer` / `CreateTargetGroup` on identical settings, per the
 * API reference) or
 * OVERWRITES it (EventBridge `PutRule`, CloudWatch `PutMetricAlarm`), or the
 * provider reads the refusal as success and configures the existing resource
 * (S3's `BucketAlreadyOwnedByYou` and the `us-east-1` legacy 200; CloudWatch
 * Logs' `ResourceAlreadyExistsException`). A replacement renamed onto such a name "succeeds" with
 * someone else's resource, which the deploy then records as its own and a
 * later destroy deletes (go-to-k/cdkd#3937); a plain CREATE under such a name
 * does the same (go-to-k/cdkd#4180). The create cannot tell a fresh
 * resource from an existing one, so the caller asks BEFORE it
 * ({@link replacementNameProbe}, {@link createNameQuestion}). Cloud Control is exempt: its handlers
 * refuse an existing identifier with `AlreadyExists`. ELBv2's providers
 * rewrite the template's name before sending it, so their `import()` looks up
 * the name the create would send, derived in the same async scope.
 *
 * The lookup and the create are two calls, so a resource created under the
 * name between them is not seen: the probe narrows the window, it cannot
 * close it.
 */
const NAME_ADOPTING_SDK_CREATE_TYPES: ReadonlySet<string> = new Set([
  'AWS::CloudWatch::Alarm',
  'AWS::ECS::Cluster',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::Events::Rule',
  'AWS::Logs::LogGroup',
  'AWS::S3::Bucket',
  'AWS::SNS::Topic',
  'AWS::SQS::Queue',
  'AWS::StepFunctions::StateMachine',
]);

/** A Step Functions state machine ARN, split before its name. */
const STATE_MACHINE_ARN = /^(arn:[^:]+:states:[^:]+:[^:]+:stateMachine:)[^:]+$/;

/** Does this create hand back or overwrite a resource already holding its name? */
export function replacementCreateAdoptsName(
  resourceType: string,
  createdVia: ProvisionedBy | undefined
): boolean {
  return createdVia !== 'cc-api' && NAME_ADOPTING_SDK_CREATE_TYPES.has(resourceType);
}

/**
 * How to ask a name-adopting create's provider whether a resource already
 * holds `change.desiredName` (go-to-k/cdkd#3937): the extra
 * `ResourceImportInput` fields its `import()` needs beside the create's bag,
 * which carries the name. `undefined` when the create cannot adopt (another
 * type, or the Cloud Control route); `null` when it can but cdkd cannot build
 * the question, which the caller refuses.
 *
 * Step Functions' `import()` has no name lookup, so the ARN the name would
 * take is derived from the old resource's ARN — a state machine's, or, across
 * a Type change, any ARN in the STACK's region (`region`), for its partition,
 * region and account; an ARN of another region refuses. Not from
 * `getAccountInfo`, which answers a FABRICATED account when STS is
 * unreachable: a lookup of a made-up ARN answers "free".
 */
export function replacementNameProbe(input: {
  resourceType: string;
  createdVia: ProvisionedBy | undefined;
  change: ReplacementNameChange;
  /** The stack's region, which a derived state machine ARN must carry. */
  region?: string | undefined;
}): { knownPhysicalId?: string } | null | undefined {
  if (!replacementCreateAdoptsName(input.resourceType, input.createdVia)) return undefined;
  if (input.resourceType !== 'AWS::StepFunctions::StateMachine') return {};
  if (input.change.desiredName.includes(':')) return null;
  const own = STATE_MACHINE_ARN.exec(input.change.physicalId);
  if (own !== null) return { knownPhysicalId: `${own[1]}${input.change.desiredName}` };
  const other = ANY_ARN.exec(input.change.physicalId);
  if (other === null || input.region === undefined || other[2] !== input.region) return null;
  return {
    knownPhysicalId: `arn:${other[1]}:states:${other[2]}:${other[3]}:stateMachine:${input.change.desiredName}`,
  };
}

/** A plain CREATE's explicit name, for {@link createNameQuestion}. */
export interface CreateNameQuestion {
  /** The template's name property, e.g. `QueueName`. */
  property: string;
  /** The name the create sends. */
  desiredName: string;
}

/**
 * The plain-CREATE sibling of {@link replacementNameProbe}
 * (go-to-k/cdkd#4180): the explicit name a name-adopting create is about to
 * send, which the caller looks up before the create. `undefined` when the
 * create cannot adopt (another type, the Cloud Control route) or carries no
 * explicit name.
 *
 * A holder found under the name is refused whoever owns it, as
 * CloudFormation's create fails with "already exists". That includes cdkd's
 * own orphan from an earlier interrupted deploy: nothing in AWS tells it apart
 * from a resource made outside the stack, and a template-supplied name may
 * belong to anyone — the reason the orphan-adoption pre-pass never adopts an
 * explicitly named resource either. A cdkd-generated name is not asked: it is
 * derived from the stack and logical id, so its holder is presumed this
 * stack's own, the premise that pre-pass is built on (a maintainer decision,
 * go-to-k/cdkd#4345).
 */
export function createNameQuestion(input: {
  resourceType: string;
  createdVia: ProvisionedBy | undefined;
  properties: Record<string, unknown>;
}): CreateNameQuestion | undefined {
  if (!replacementCreateAdoptsName(input.resourceType, input.createdVia)) return undefined;
  const property = explicitNamePropertyFor(input.resourceType);
  if (property === undefined) return undefined;
  // A number reaches the create as one, which AWS takes as its decimal
  // spelling, so it is a name to look up too.
  const raw = input.properties[property];
  const desiredName =
    typeof raw === 'number' && Number.isFinite(raw)
      ? String(raw)
      : nameValue(input.properties, property);
  return desiredName === undefined ? undefined : { property, desiredName };
}

/**
 * The ARN a NEW resource named `name` would take, for the types whose
 * {@link createNameQuestion} lookup goes by ARN: Step Functions (its
 * `import()` has no name lookup) and SNS (whose name lookup pages `ListTopics`
 * region-wide). `undefined` for any other type, which looks the name up
 * itself. Otherwise the ARN, or why it cannot be built honestly:
 * `'name'` for a name carrying `:`, `'account'` for an account
 * `getAccountInfo` FABRICATED because STS was unreachable (or a malformed
 * one) — a lookup of a made-up ARN answers "free".
 */
export function createLookupArn(
  resourceType: string,
  name: string,
  account: { partition: string; region: string; accountId: string; fabricated?: boolean }
): { arn: string } | { unbuildable: 'name' | 'account' } | undefined {
  const shape = CREATE_LOOKUP_ARN[resourceType];
  if (shape === undefined) return undefined;
  if (name.includes(':')) return { unbuildable: 'name' };
  if (account.fabricated === true || !/^\d{12}$/.test(account.accountId) || account.region === '') {
    return { unbuildable: 'account' };
  }
  return {
    arn: `arn:${account.partition}:${shape.service}:${account.region}:${account.accountId}:${shape.prefix}${name}`,
  };
}

const CREATE_LOOKUP_ARN: Readonly<Record<string, { service: string; prefix: string }>> = {
  'AWS::SNS::Topic': { service: 'sns', prefix: '' },
  'AWS::StepFunctions::StateMachine': { service: 'states', prefix: 'stateMachine:' },
};

/** Any ARN carrying a region and a 12-digit account: partition, region, account. */
const ANY_ARN = /^arn:([^:]+):[^:]+:([a-z0-9-]+):(\d{12}):/;

/** Credential and clock failures: a re-run can fix these, so they are not a 403 about the name. */
const S3_CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  'ExpiredToken',
  'InvalidAccessKeyId',
  'InvalidToken',
  'RequestTimeTooSkewed',
  'SignatureDoesNotMatch',
  'TokenRefreshRequired',
]);

/**
 * Is a name probe's failure S3's `HeadBucket` 403? It has several causes —
 * another account owns the name, a bucket of THIS account denies this
 * identity `s3:ListBucket`, or the credentials were rejected — so the caller
 * refuses with all of them named rather than "re-run once the check can
 * succeed", which no re-run satisfies in the first two. An error NAMED as a
 * credential or clock failure is left to that generic refusal.
 */
export function probeErrorMeansNameHeld(resourceType: string, error: unknown): boolean {
  if (resourceType !== 'AWS::S3::Bucket' || error === null || typeof error !== 'object') {
    return false;
  }
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof e.name === 'string' && S3_CREDENTIAL_ERRORS.has(e.name)) return false;
  return e.name === 'Forbidden' || e.$metadata?.httpStatusCode === 403;
}

/**
 * {@link renderNameHeldElsewhere}, except for an EventBridge rule moving bus
 * ({@link replacementMovesEventBus}): there the NAME is the rule's, and what
 * another resource holds is that name on the new bus, not the bus.
 */
export function renderReplacementNameChange(
  change: ReplacementNameChange,
  createProps: Record<string, unknown>
): string {
  if (change.property !== 'EventBusName') return renderNameHeldElsewhere(change);
  const name = createProps['Name'];
  const rule =
    typeof name === 'string' && isPlainName(name) ? `rule "${name}"` : 'the rule (by its Name)';
  const bus = (value: string | undefined, fallback: string): string =>
    value !== undefined && isPlainName(value) ? `bus "${value}"` : fallback;
  return (
    `The replacement moves ${rule} from ${bus(change.heldName, 'its current bus')} to ` +
    `${bus(change.desiredName, 'another bus')}, where another rule already holds that name`
  );
}

/**
 * Should a replacement's ORDER treat names case-sensitively (go-to-k/cdkd#3931)?
 * Deleting first is right only when the old resource holds the new name, so
 * the order compares exactly unless the type's name space is KNOWN to fold
 * case ({@link CASE_INSENSITIVE_NAME_TYPES}). A case-insensitive service
 * reached here refuses the create-first collision with nothing deleted — the
 * safe direction.
 */
export function replacementOrderIsCaseSensitive(resourceType: string): boolean {
  return !CASE_INSENSITIVE_NAME_TYPES.has(resourceType);
}

const DEFAULT_EVENT_BUS = 'default';

/** An EventBridge bus as a name: an ARN's `event-bus/<name>`, absent as `default`. */
function eventBusName(value: unknown): string | undefined {
  if (value === undefined) return DEFAULT_EVENT_BUS;
  if (typeof value !== 'string' || value === '' || value === SECRET_MASK) return undefined;
  if (value.includes('{{resolve:')) return undefined;
  const arn = /^arn:[^:]+:events:[^:]*:[^:]*:event-bus\/(.+)$/.exec(value);
  return arn === null ? value : arn[1];
}

/**
 * Does an EventBridge rule's replacement MOVE it to another bus
 * (go-to-k/cdkd#3937)? A rule's name is scoped by its bus, so a rule keeping
 * its `Name` on a new bus asks for a name the old rule does not hold there —
 * and `PutRule` overwrites a rule of that name on the new bus. Answers only a
 * KNOWN move; an unreadable bus on either side keeps the pre-existing order.
 */
export function replacementMovesEventBus(input: {
  oldResourceType: string;
  newResourceType: string;
  desiredProperties: Record<string, unknown> | undefined;
  recorded: Record<string, unknown> | undefined;
  observed: Record<string, unknown> | undefined;
  physicalId: string;
}): ReplacementNameChange | undefined {
  const rule = 'AWS::Events::Rule';
  if (input.oldResourceType !== rule || input.newResourceType !== rule) return undefined;
  const desired = eventBusName(input.desiredProperties?.['EventBusName']);
  const recordedBus = input.recorded?.['EventBusName'];
  const observedBus = input.observed?.['EventBusName'];
  const held = eventBusName(recordedBus !== undefined ? recordedBus : observedBus);
  if (desired === undefined || held === undefined || desired === held) return undefined;
  return {
    property: 'EventBusName',
    desiredName: desired,
    heldName: held,
    heldProperty: 'EventBusName',
    physicalId: input.physicalId,
  };
}

/**
 * Do two physical ids a name probe compares name the same resource? Exact,
 * except an SQS queue URL, whose host AWS spells two ways
 * (`sqs.<region>.amazonaws.com` and the legacy `<region>.queue.amazonaws.com`):
 * there the `/<account>/<name>` path decides.
 */
export function probeFoundSameId(resourceType: string, a: string, b: string): boolean {
  if (a === b) return true;
  if (resourceType !== 'AWS::SQS::Queue') return false;
  const path = (url: string): string | undefined =>
    /^https:\/\/[^/]+(\/\d+\/[^/]+)\/?$/.exec(url)?.[1];
  const pa = path(a);
  return pa !== undefined && pa === path(b);
}

/** The pinned {@link NAME_ADOPTING_SDK_CREATE_TYPES}, for tests. */
export function nameAdoptingSdkCreateTypes(): readonly string[] {
  return [...NAME_ADOPTING_SDK_CREATE_TYPES].sort();
}

/**
 * How a type's colliding name is read from a property bag, for
 * {@link reverseReplacementNewHoldsName}. `name` lists alternative paths (the
 * first that yields a name wins); `scope` lists the properties that place the
 * name — two resources of one name in different scopes are two resources, so
 * a scope that differs means the new resource cannot hold the old one's name.
 * An absent scope property reads as `scopeDefaults[i]` when one is given.
 */
interface NameKey {
  readonly name: ReadonlyArray<readonly string[]>;
  readonly scope?: ReadonlyArray<readonly string[]>;
  readonly scopeDefaults?: ReadonlyArray<string | undefined>;
}

const flat = (property: string): NameKey => ({ name: [[property]] });

/**
 * A per-type table's OWN entry: a resource type is template text, and an
 * inherited key (`constructor`, `__proto__`, `toString`) must read as absent,
 * never as an entry.
 */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The name key of every type whose name is NOT read by the generic
 * {@link explicitNamePropertyFor} rule — a nested name, a name placed by a
 * parent (scope), or a type absent from that table — keyed by type.
 */
const REVERSE_REPLACEMENT_NAME_KEYS: Readonly<Record<string, NameKey>> = {
  'AWS::ApiGateway::Stage': { name: [['StageName']], scope: [['RestApiId']] },
  'AWS::ApiGatewayV2::Stage': { name: [['StageName']], scope: [['ApiId']] },
  'AWS::AppSync::DataSource': { name: [['Name']], scope: [['ApiId']] },
  'AWS::AppSync::Resolver': { name: [['FieldName']], scope: [['ApiId'], ['TypeName']] },
  'AWS::BedrockAgentCore::Evaluator': flat('EvaluatorName'),
  'AWS::BedrockAgentCore::Runtime': flat('AgentRuntimeName'),
  'AWS::Budgets::Budget': { name: [['Budget', 'BudgetName']] },
  'AWS::CloudTrail::Trail': flat('TrailName'),
  'AWS::Cognito::UserPoolIdentityProvider': {
    name: [['ProviderName']],
    scope: [['UserPoolId']],
  },
  'AWS::EC2::SecurityGroup': { name: [['GroupName']], scope: [['VpcId']] },
  'AWS::ECS::Service': {
    name: [['ServiceName']],
    scope: [['Cluster']],
    scopeDefaults: ['default'],
  },
  'AWS::Events::Rule': {
    name: [['Name']],
    scope: [['EventBusName']],
    scopeDefaults: ['default'],
  },
  'AWS::Glue::Connection': { name: [['ConnectionInput', 'Name']] },
  'AWS::Glue::Crawler': flat('Name'),
  'AWS::Glue::Database': { name: [['DatabaseInput', 'Name'], ['DatabaseName']] },
  'AWS::Glue::Job': flat('Name'),
  'AWS::Glue::SecurityConfiguration': flat('Name'),
  'AWS::Glue::Table': { name: [['TableInput', 'Name']], scope: [['DatabaseName']] },
  'AWS::Glue::Trigger': flat('Name'),
  'AWS::Glue::Workflow': flat('Name'),
  'AWS::Kinesis::StreamConsumer': { name: [['ConsumerName']], scope: [['StreamARN']] },
  'AWS::KinesisFirehose::DeliveryStream': flat('DeliveryStreamName'),
  'AWS::KMS::Alias': flat('AliasName'),
  'AWS::Lambda::MicrovmImage': flat('Name'),
  'AWS::RDS::DBProxyTargetGroup': { name: [['TargetGroupName']], scope: [['DBProxyName']] },
  'AWS::S3Tables::TableBucket': flat('TableBucketName'),
  'AWS::S3Vectors::VectorBucket': flat('VectorBucketName'),
  'AWS::Scheduler::Schedule': {
    name: [['Name']],
    scope: [['GroupName']],
    scopeDefaults: ['default'],
  },
  'AWS::ServiceDiscovery::HttpNamespace': flat('Name'),
  'AWS::ServiceDiscovery::PrivateDnsNamespace': { name: [['Name']], scope: [['Vpc']] },
  'AWS::ServiceDiscovery::PublicDnsNamespace': flat('Name'),
  'AWS::ServiceDiscovery::Service': { name: [['Name']], scope: [['NamespaceId']] },
  'AWS::WAFv2::WebACL': { name: [['Name']], scope: [['Scope']] },
};

/**
 * Types no name proves a holder for, so a collision on one is refused: the
 * name is not unique (Route 53 hosted zones, ACM certificates, EMR clusters,
 * Cognito user pools), the write is an upsert (an inline IAM policy), the
 * name-shaped create-only property names a PARENT, or — a nested stack — the
 * child's `<parent>~<logicalId>` is a state key AWS never sees, so no AWS
 * collision can be the stack's own (a child resource's collision reaches the
 * parent only through the anchor residual in `retryable-errors/name-collision.ts`).
 */
const NOT_NAME_KEYED_TYPES: ReadonlySet<string> = new Set([
  'AWS::CertificateManager::Certificate',
  'AWS::CloudFormation::Stack',
  'AWS::CloudWatch::AnomalyDetector',
  'AWS::Cognito::UserPool',
  'AWS::EC2::Instance',
  'AWS::EC2::SecurityGroupIngress',
  'AWS::EFS::FileSystem',
  'AWS::EMR::Cluster',
  'AWS::EMR::InstanceFleetConfig',
  'AWS::EMR::InstanceGroupConfig',
  'AWS::IAM::AccessKey',
  'AWS::IAM::Policy',
  'AWS::Lambda::EventInvokeConfig',
  'AWS::Lambda::Permission',
  'AWS::Route53::HostedZone',
]);

/**
 * Types whose NAME space ignores case (the service lower-cases the name, or
 * refuses a second spelling), so a case-only difference is the same name.
 * Every other type compares names EXACTLY: `Orders` and `orders` are two
 * DynamoDB tables, and a folded match there would "prove" the wrong holder.
 * A type missing here only refuses a case-only rename — the safe direction.
 */
const CASE_INSENSITIVE_NAME_TYPES: ReadonlySet<string> = new Set([
  // Each is a service that stores the identifier lower-cased (RDS, DocDB,
  // Neptune and ElastiCache identifiers and subnet groups) or refuses a second
  // spelling of it (IAM names). Unverified services stay out.
  'AWS::DocDB::DBCluster',
  'AWS::DocDB::DBInstance',
  'AWS::DocDB::DBSubnetGroup',
  'AWS::ElastiCache::CacheCluster',
  'AWS::ElastiCache::SubnetGroup',
  'AWS::IAM::Group',
  'AWS::IAM::InstanceProfile',
  'AWS::IAM::ManagedPolicy',
  'AWS::IAM::Role',
  'AWS::IAM::User',
  'AWS::Neptune::DBCluster',
  'AWS::Neptune::DBInstance',
  'AWS::Neptune::DBSubnetGroup',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBSubnetGroup',
]);

/**
 * Types whose SDK provider mints `applyDefaultNameForFallback`'s name VERBATIM
 * for a nameless create (same maxLength, pattern and case, no prefix or
 * suffix), audited provider by provider. Only for these does the `generated`
 * bag name what the create sent; every other type ignores it, so a wrap the
 * audit did not see (a log group's `/cdkd/<name>`, an SSM parameter's
 * `/<name>`, a directory bucket's `--<az>--x-s3`, an S3 bucket's pattern
 * keeping `.`) can only refuse, never
 * prove a holder. Adding a type is a deliberate edit of the pinned literal.
 * A type in {@link SENT_NAME_REWRITTEN} is never here: its provider derives
 * even an EXPLICIT name, so that table owns its whole name.
 */
const GENERATED_NAME_VERBATIM: ReadonlySet<string> = new Set([
  'AWS::CloudWatch::Alarm',
  'AWS::DocDB::DBCluster',
  'AWS::DocDB::DBInstance',
  'AWS::DocDB::DBSubnetGroup',
  'AWS::DynamoDB::Table',
  'AWS::ECR::Repository',
  'AWS::ECS::Cluster',
  'AWS::ECS::Service',
  'AWS::ElastiCache::CacheCluster',
  'AWS::ElastiCache::SubnetGroup',
  'AWS::Events::Rule',
  'AWS::Kinesis::Stream',
  'AWS::Lambda::Function',
  'AWS::Neptune::DBCluster',
  'AWS::Neptune::DBInstance',
  'AWS::Neptune::DBSubnetGroup',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBSubnetGroup',
  'AWS::SecretsManager::Secret',
  'AWS::SNS::Topic',
  'AWS::SQS::Queue',
  'AWS::StepFunctions::StateMachine',
  'AWS::WAFv2::WebACL',
]);

/**
 * Types whose SDK provider sends `generateResourceNameWithFallback(<property>,
 * logicalId, { maxLength })` — for an explicit name too — so the name AWS is
 * asked for is NOT the recorded one: it depends on the stack-name scope
 * (`withStackName`) and the prefix flag (`withSkipPrefix`) — the failed
 * deploy's flag, which `cdkd rollback` restores from the journal segment
 * (go-to-k/cdkd#4018), unless {@link replayPrefixChoice} finds that the OTHER
 * flag created the old resource (go-to-k/cdkd#4024) — and the default pattern
 * rewrites `_` and `.` to `-`. So a recorded name proves nothing here: the
 * name the re-create sends is derived IN THE CURRENT SCOPE by the provider's
 * own generator, and only the new resource's physical id naming THAT name
 * proves a holder. Fenced against the generator's callers in
 * `src/provisioning/providers/`.
 */
const SENT_NAME_REWRITTEN: Readonly<
  Record<string, { readonly property: string; readonly maxLength: number }>
> = {
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { property: 'Name', maxLength: 32 },
  'AWS::ElasticLoadBalancingV2::TargetGroup': { property: 'Name', maxLength: 32 },
  'AWS::IAM::Group': { property: 'GroupName', maxLength: 128 },
  'AWS::IAM::InstanceProfile': { property: 'InstanceProfileName', maxLength: 128 },
  'AWS::IAM::ManagedPolicy': { property: 'ManagedPolicyName', maxLength: 128 },
  'AWS::IAM::Role': { property: 'RoleName', maxLength: 64 },
  'AWS::IAM::User': { property: 'UserName', maxLength: 64 },
};

/**
 * Which user-supplied-name prefix flag a rollback replays one op under
 * (go-to-k/cdkd#4024). See {@link replayPrefixChoice}.
 *
 * - `not-applicable`: the flag cannot change what is sent (not a
 *   `SENT_NAME_REWRITTEN` type, a Cloud Control route, or no explicit name —
 *   a logical-id name keeps the prefix under either flag).
 * - `reproduced`: `skipPrefix` derives a name the old physical id names.
 * - `unreproduced`: neither flag does, or it cannot be decided; `skipPrefix`
 *   is the current scope's (the failed deploy's) and `names` the two
 *   derivations when they could be computed.
 */
export type ReplayPrefixChoice =
  | { readonly kind: 'not-applicable' }
  | {
      readonly kind: 'reproduced';
      readonly skipPrefix: boolean;
      /** The current scope's flag, for the caller's note when it differs. */
      readonly recorded: boolean;
      readonly property: string;
      /** The declared (PLAINTEXT) name, so a caller can tell a secret-derived one. */
      readonly declared: string;
      readonly names: { readonly skipped: string; readonly kept: string };
    }
  | {
      readonly kind: 'unreproduced';
      readonly skipPrefix: boolean;
      readonly property: string;
      readonly declared: string | undefined;
      readonly names: { readonly skipped: string; readonly kept: string } | undefined;
    };

/**
 * The prefix flag a rollback should replay an op of a `SENT_NAME_REWRITTEN`
 * type under: the one whose derived name REPRODUCES the old resource's
 * physical id (go-to-k/cdkd#4024).
 *
 * The replay's scope carries the FAILED deploy's flag (#4018), but the old
 * resource was created by an EARLIER deploy, which may have run under the
 * other one. Its provider derives the name from the flag (for a re-create,
 * and for an in-place `update()` that re-derives the name and replaces on a
 * mismatch), so replaying under the failed deploy's flag restores the resource
 * under a name it never had. The physical id records the name it DID have:
 * the name itself for an IAM Role / User / Group / InstanceProfile, the last
 * `/` segment of a ManagedPolicy ARN (`arn:…:policy[/path]/<name>`), the name
 * segment of an ELBv2 ARN (`…:targetgroup/<name>/<id>`,
 * `…:loadbalancer/<app|net|gwy>/<name>/<id>`).
 *
 * Call it in the replay's own async scope (stack name, recorded flag): both
 * derivations run there with only the flag overridden. The current flag wins
 * when both derive a name the id names (no stack name in scope); neither, or
 * an old id / explicit name cdkd cannot read, keeps the current flag as
 * `unreproduced`, which the caller warns about. Names compare in the type's
 * case rule (`CASE_INSENSITIVE_NAME_TYPES`).
 */
export function replayPrefixChoice(input: {
  resourceType: string;
  /** The bag the replay sends (the old resource's resolved properties). */
  properties: Record<string, unknown> | undefined;
  logicalId: unknown;
  /** The old resource's physical id. */
  physicalId: unknown;
  /** The route the replay's create / update takes. */
  via: ProvisionedBy | undefined;
}): ReplayPrefixChoice {
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, input.resourceType);
  if (rewrite === undefined || input.via === 'cc-api') return { kind: 'not-applicable' };
  const raw = input.properties?.[rewrite.property];
  // What `generateResourceNameWithFallback` reads as "no explicit name": the
  // logical-id name is prefixed under either flag. A `null` is NOT that (the
  // generator passes it on), so it falls to the undecided arm below.
  if (raw === undefined || raw === '') return { kind: 'not-applicable' };
  const recorded = getCurrentSkipPrefix();
  const property = rewrite.property;
  const declared = valueAt(input.properties, [property]);
  if (
    declared === undefined ||
    typeof input.logicalId !== 'string' ||
    typeof input.physicalId !== 'string' ||
    input.physicalId === ''
  ) {
    return { kind: 'unreproduced', skipPrefix: recorded, property, declared, names: undefined };
  }
  const [skipped = '', kept = ''] = rewrittenNameSpellings(
    input.resourceType,
    declared,
    input.logicalId
  );
  const fold = CASE_INSENSITIVE_NAME_TYPES.has(input.resourceType)
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value;
  const id = fold(input.physicalId);
  const names = { skipped, kept };
  const reproduces = (skip: boolean): boolean => {
    const name = skip ? names.skipped : names.kept;
    return name !== '' && holderIdNames(id, fold(name));
  };
  const decided = { recorded, property, declared, names };
  if (reproduces(recorded)) return { kind: 'reproduced', skipPrefix: recorded, ...decided };
  if (reproduces(!recorded)) return { kind: 'reproduced', skipPrefix: !recorded, ...decided };
  return { kind: 'unreproduced', skipPrefix: recorded, property, declared, names };
}

/**
 * The names a `SENT_NAME_REWRITTEN` type's provider derives from `declared`
 * under EACH prefix setting, in the caller's async scope (stack name), for the
 * rollback executor's derived-name masks (go-to-k/cdkd#4037). Empty for any
 * other type, a nameless bag, or an id cdkd cannot derive from.
 */
export function rewrittenNameSpellings(
  resourceType: string,
  declared: string,
  logicalId: unknown
): string[] {
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, resourceType);
  if (rewrite === undefined || declared === '' || typeof logicalId !== 'string') return [];
  return [true, false].map((skip) =>
    withSkipPrefix(skip, () =>
      generateResourceNameWithFallback(declared, logicalId, { maxLength: rewrite.maxLength })
    )
  );
}

/**
 * The name a `SENT_NAME_REWRITTEN` provider sends for `properties`' explicit
 * name, derived in the CALLER's async scope (stack name, prefix flag), or
 * `undefined` for another type or without an explicit string name.
 */
function sentRewrittenName(
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  logicalId: string
): { property: string; declared: string; sent: string } | undefined {
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, resourceType);
  if (rewrite === undefined) return undefined;
  const declared = properties?.[rewrite.property];
  if (typeof declared !== 'string' || declared === '') return undefined;
  const sent = generateResourceNameWithFallback(declared, logicalId, {
    maxLength: rewrite.maxLength,
  });
  return { property: rewrite.property, declared, sent };
}

/** The name segment of an ELBv2 load balancer or target group ARN. */
const ELBV2_ARN_NAME =
  /^arn:[^:]+:elasticloadbalancing:[^:]*:[^:]*:(?:loadbalancer\/(?:app|net|gwy)\/|targetgroup\/)([^/]+)\/[^/]+$/;

/**
 * Does a name-adopting, name-REWRITING create send a name the old resource
 * does not hold although the template's name did not change
 * (go-to-k/cdkd#3937 review)? ELBv2 sends the template `Name` with the
 * stack-name prefix under `--prefix-user-supplied-names` only, so a
 * replacement under the other flag than the one that created the old
 * resource SENDS another name, and {@link replacementRequestsDifferentName}
 * — which compares template names — never asks the probe. The sent name is
 * compared, exactly, with the name the old physical id carries; anything
 * unreadable answers `undefined`, the pre-existing behaviour.
 */
export function replacementSentNameMoves(input: {
  oldResourceType: string;
  newResourceType: string;
  createdVia: ProvisionedBy | undefined;
  desiredProperties: Record<string, unknown> | undefined;
  physicalId: string;
  logicalId: string;
}): ReplacementNameChange | undefined {
  if (input.oldResourceType !== input.newResourceType) return undefined;
  if (!replacementCreateAdoptsName(input.newResourceType, input.createdVia)) return undefined;
  const sent = sentRewrittenName(input.newResourceType, input.desiredProperties, input.logicalId);
  if (sent === undefined || sent.declared.includes('{{resolve:')) return undefined;
  const held = ELBV2_ARN_NAME.exec(input.physicalId)?.[1];
  if (held === undefined || held === sent.sent) return undefined;
  return {
    property: sent.property,
    desiredName: sent.sent,
    heldName: held,
    heldProperty: sent.property,
    physicalId: input.physicalId,
  };
}

/**
 * `base`, extended to mask the spelling a `SENT_NAME_REWRITTEN` provider
 * sends for a SECRET-derived explicit name (go-to-k/cdkd#3937 review): the
 * rewrite (`_` / `.` to `-`, a prefix, a hash past the cap) is not the
 * plaintext the base masker matches, and a name probe's refusal prints the
 * holder's ARN, which carries that spelling, under either prefix flag. Any
 * other type, or a name that
 * is not secret-derived, returns `base` unchanged.
 */
export function maskRewrittenSentName(
  resourceType: string,
  properties: Record<string, unknown> | undefined,
  logicalId: string,
  base: (text: string) => string
): (text: string) => string {
  const sent = sentRewrittenName(resourceType, properties, logicalId);
  if (sent === undefined) return base;
  // Both prefix flags' spellings: a probe of a sent name the flag moved
  // ({@link replacementSentNameMoves}) prints the OLD resource's name, the
  // other flag's spelling of the same value.
  const spellings = [sent.sent, ...rewrittenNameSpellings(resourceType, sent.declared, logicalId)];
  const quiet = { debug: (): void => undefined, warn: (): void => undefined };
  return withDerivedNameMasks(
    quiet,
    {
      mask: base,
      value: (value: unknown) => base(String(value)),
      debug: quiet.debug,
      warn: quiet.warn,
    },
    spellings.map((spelling) => [sent.declared, spelling] as const)
  ).mask;
}

/** The rewriting types and their generator options, for the fence. */
export function reverseReplacementRewrittenNameTypes(): Readonly<
  Record<string, { readonly property: string; readonly maxLength: number }>
> {
  return SENT_NAME_REWRITTEN;
}

/** The case-insensitive name spaces, for the test that pins the list. */
export function reverseReplacementCaseInsensitiveTypes(): readonly string[] {
  return [...CASE_INSENSITIVE_NAME_TYPES].sort();
}

/** The audited verbatim-generation types, for the test that pins the list. */
export function reverseReplacementVerbatimGeneratedTypes(): readonly string[] {
  return [...GENERATED_NAME_VERBATIM].sort();
}

/** Does cdkd's generation rule name what this type's nameless create sends? */
export function reverseReplacementTrustsGeneratedName(resourceType: string): boolean {
  return GENERATED_NAME_VERBATIM.has(resourceType);
}

/**
 * Groups of DIFFERENT types that share one name space, so across a `Type`
 * change the new resource can hold the old one's name. The RDS, DocumentDB
 * and Neptune management APIs are one API over one set of identifiers per
 * account and region: Neptune's `DescribeDBClusters` "can also return
 * information for Amazon RDS clusters and Amazon DocDB clusters", so a
 * cluster, an instance or a subnet group of one engine collides with the
 * same identifier of another. Any other pair is UNKNOWN, never "different".
 */
const SHARED_NAME_SPACES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable']),
  new Set(['AWS::RDS::DBCluster', 'AWS::DocDB::DBCluster', 'AWS::Neptune::DBCluster']),
  new Set(['AWS::RDS::DBInstance', 'AWS::DocDB::DBInstance', 'AWS::Neptune::DBInstance']),
  new Set(['AWS::RDS::DBSubnetGroup', 'AWS::DocDB::DBSubnetGroup', 'AWS::Neptune::DBSubnetGroup']),
];

const RECORD_SET = 'AWS::Route53::RecordSet';

/** How {@link reverseReplacementNewHoldsName} reads a type's name. */
export function reverseReplacementNameKeyKind(
  resourceType: string
): 'keyed' | 'record-set' | 'not-name-keyed' | 'unknown' {
  if (resourceType === RECORD_SET) return 'record-set';
  if (NOT_NAME_KEYED_TYPES.has(resourceType)) return 'not-name-keyed';
  if (nameKeyFor(resourceType) !== undefined) return 'keyed';
  return 'unknown';
}

function nameKeyFor(resourceType: string): NameKey | undefined {
  if (NOT_NAME_KEYED_TYPES.has(resourceType)) return undefined;
  const own = ownEntry(REVERSE_REPLACEMENT_NAME_KEYS, resourceType);
  if (own !== undefined) return own;
  const property = explicitNamePropertyFor(resourceType);
  // That table is read by plain indexing: an inherited member is no name.
  return typeof property === 'string' ? flat(property) : undefined;
}

function valueAt(
  bag: Record<string, unknown> | undefined,
  path: readonly string[]
): string | undefined {
  let node: unknown = bag;
  for (const segment of path.slice(0, -1)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = Object.prototype.hasOwnProperty.call(node, segment)
      ? (node as Record<string, unknown>)[segment]
      : undefined;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const last = path[path.length - 1]!;
  if (!Object.prototype.hasOwnProperty.call(node, last)) return undefined;
  return nameValue(node as Record<string, unknown>, last);
}

/** Is `bag` carrying a secret mask, a reference or a non-string at `path`? */
function unreadableAt(bag: Record<string, unknown> | undefined, path: readonly string[]): boolean {
  let node: unknown = bag;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return node !== undefined && node !== null && valueAt(bag, path) === undefined;
}

/**
 * The NEW resource's value at `path`: recorded, else observed. `unreadable`
 * when the side that would answer holds something that is not a name — an
 * observed value is never allowed to stand behind a recorded mask, nor a
 * scope default behind an observed one.
 */
function heldAt(
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  path: readonly string[]
): { value: string | undefined; unreadable: boolean } {
  if (unreadableAt(recorded, path)) return { value: undefined, unreadable: true };
  const value = valueAt(recorded, path) ?? valueAt(observed, path);
  return { value, unreadable: value === undefined && unreadableAt(observed, path) };
}

const isArn = (value: string): boolean => value.startsWith('arn:');

/**
 * Does `physicalId` name `name`? The deploy side's rule
 * ({@link physicalIdNames}), plus the ELBv2 ARN, whose name segment is
 * followed by a generated id (`...:targetgroup/<name>/<id>`,
 * `...:loadbalancer/<app|net|gwy>/<name>/<id>`) — the one id a same-name
 * replacement CHANGES. Both arguments are already in the comparison's case.
 */
function holderIdNames(physicalId: string, name: string): boolean {
  if (physicalIdNames(physicalId, name)) return true;
  const elbv2 =
    /^arn:[^:]+:elasticloadbalancing:[^:]*:[^:]*:(?:targetgroup|loadbalancer\/(?:app|net|gwy))\/([^/]+)\/[^/]+$/.exec(
      physicalId
    );
  return elbv2 !== null && elbv2[1] === name;
}

/** A Route 53 name or zone name: DNS ignores case, and the trailing dot is optional. */
const dnsFold = (value: string): string => value.toLowerCase().replace(/\.$/, '');

/** A hosted zone id, with or without its `/hostedzone/` prefix. */
const zoneIdFold = (value: string): string => value.replace(/^\/hostedzone\//i, '');

/**
 * The verdict of {@link reverseReplacementNewHoldsName}. `holds: false`
 * carries a DISPLAY-SAFE `diagnosis` clause naming the colliding name when it
 * is known, and `known`: `true` when the records show the new resource holds a
 * DIFFERENT name (so another resource holds the colliding one), `false` when
 * they cannot decide.
 */
export type ReverseReplacementHolderVerdict =
  | { readonly holds: true }
  | { readonly holds: false; readonly known: boolean; readonly diagnosis: string };

const HOLDS: ReverseReplacementHolderVerdict = { holds: true };

/** The records show the new resource does not hold the name. */
function elsewhere(diagnosis: string): ReverseReplacementHolderVerdict {
  return { holds: false, known: true, diagnosis };
}

/** The records cannot show whether the new resource holds the name. */
function unproven(diagnosis: string): ReverseReplacementHolderVerdict {
  return { holds: false, known: false, diagnosis };
}

/**
 * How the diagnosis shows a value: masked FIRST, while the value still has the
 * spelling the masker matches (the replay bag is PLAINTEXT, and `displayIdent`
 * escapes, strips and cuts), then `displayIdent`, which quotes any value that
 * is not plain, since the refusal ends on a pasteable `--orphan` line a forged
 * value must not imitate.
 */
interface Renderer {
  shown(value: string): string;
  quoted(value: string): string;
}

function renderer(mask: (value: string) => string): Renderer {
  const shown = (value: string): string => displayIdent(mask(value));
  return {
    shown,
    quoted(value) {
      const masked = mask(value);
      const rendered = displayIdent(masked);
      return rendered === masked ? `"${masked}"` : rendered;
    },
  };
}

/**
 * Who the diagnosis talks about. The two directions ask one question — does
 * the HOLDER hold the name the CREATE sent? — about different resources: the
 * rollback re-creates the OLD resource and asks about the NEW one, a deploy
 * `--replace` creates the NEW resource and asks about the OLD one.
 */
interface Voice {
  /** The create whose name collided, e.g. `the re-create`. */
  readonly create: string;
  /** The record that create was built from, for the record-set rule. */
  readonly createdRecord: string;
  /** The resource that must hold the name, before its physical id. */
  readonly holder: string;
  /** The same, for a Route 53 record. */
  readonly holderRecord: string;
  /** Whether a type with no name key may be proven by {@link sentIdentifierIs}. */
  readonly identityFallback: boolean;
  /** Whether `DERIVED_GENERATED_NAMES` may name what a nameless SDK create sent. */
  readonly derivedNames: boolean;
}

const ROLLBACK_VOICE: Voice = {
  create: 'the re-create',
  createdRecord: 'the re-created record',
  holder: 'the new resource',
  holderRecord: 'the new record',
  identityFallback: false,
  derivedNames: false,
};

const DEPLOY_VOICE: Voice = {
  create: 'the create',
  createdRecord: 'the replacement record',
  holder: 'the resource being replaced',
  holderRecord: 'the record being replaced',
  // The deploy's delete is the user's `--replace` opt-in, and without this
  // every Cloud Control type cdkd has no name key for would lose it.
  identityFallback: true,
  // Deploy only, like the identity rule: the rollback keeps refusing a
  // nameless re-create of these types.
  derivedNames: true,
};

/**
 * For a type cdkd has NO name key for (in practice a Cloud Control type with
 * no schema fixture), created and held through Cloud Control: did the create
 * SEND the holder's own physical id as a top-level name-shaped (`...Name` /
 * `...Identifier`) property, exactly, while EVERY name-shaped property it sent
 * equals the holder's recorded (then observed) value of it? A Cloud Control
 * physical id is the primary identifier, so a create sending it asked for the
 * holder's own identifier; the second half keeps a renamed resource whose
 * OTHER name-shaped property still spells the old id (a `RoleName` pointing
 * elsewhere) from passing as unchanged. Exact and case-sensitive: an id that
 * merely ENDS with the value (a composite `<parent>|<name>`) stays unproven.
 */
function sentIdentifierIs(
  requested: Record<string, unknown>,
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  physicalId: string
): boolean {
  const isNameKey = (key: string): boolean => /(Name|Identifier)$/.test(key);
  // `valueAt` never yields `''`, so an empty id matches nothing.
  if (
    !Object.keys(requested).some(
      (key) => isNameKey(key) && valueAt(requested, [key]) === physicalId
    )
  ) {
    return false;
  }
  // The union with the keys the holder's TEMPLATE declared (its record): a
  // name-shaped property the template DROPPED is a change too, not an
  // absence to skip. Not the observed bag's keys — a read-back can report a
  // name AWS defaulted that no template declared, which is no change.
  const nameKeys = new Set(
    [...Object.keys(requested), ...Object.keys(recorded ?? {})].filter(isNameKey)
  );
  return [...nameKeys].every((key) => {
    const sent = valueAt(requested, [key]);
    return sent !== undefined && heldAt(recorded, observed, [key]).value === sent;
  });
}

/**
 * Types whose SDK provider mints a nameless create's name with its OWN call to
 * `generateResourceName` — a wrap or options `applyDefaultNameForFallback` does
 * not reproduce, so they stay out of `GENERATED_NAME_VERBATIM`. The name is
 * derived here from the logical id in the create's async scope (stack name),
 * exactly as the provider does; `source` is the provider's expression, which
 * the test pins against the provider file. Only the holder's physical id
 * naming the derived name proves it.
 */
const DERIVED_GENERATED_NAMES: Readonly<
  Record<
    string,
    { readonly file: string; readonly source: string; derive(logicalId: string): string }
  >
> = {
  'AWS::AutoScaling::AutoScalingGroup': {
    file: 'asg-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 255 })',
    derive: (id) => generateResourceName(id, { maxLength: 255 }),
  },
  'AWS::CodeCommit::Repository': {
    file: 'codecommit-repository-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 100 })',
    derive: (id) => generateResourceName(id, { maxLength: 100 }),
  },
  'AWS::DynamoDB::GlobalTable': {
    file: 'dynamodb-globaltable-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 255 })',
    derive: (id) => generateResourceName(id, { maxLength: 255 }),
  },
  'AWS::Logs::LogGroup': {
    file: 'logs-loggroup-provider.ts',
    source:
      '`/cdkd/${generateResourceName(logicalId, { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`',
    derive: (id) =>
      `/cdkd/${generateResourceName(id, { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`,
  },
  'AWS::RDS::DBProxy': {
    file: 'rds-dbproxy-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 64 })',
    derive: (id) => generateResourceName(id, { maxLength: 64 }),
  },
  'AWS::RDS::DBProxyEndpoint': {
    file: 'rds-dbproxy-endpoint-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 64 })',
    derive: (id) => generateResourceName(id, { maxLength: 64 }),
  },
  'AWS::S3::Bucket': {
    file: 's3-bucket-provider.ts',
    source:
      'generateResourceName(logicalId, {\n        maxLength: 63,\n        lowercase: true,\n        allowedPattern: /[^a-z0-9.-]/g,\n      })',
    derive: (id) =>
      generateResourceName(id, { maxLength: 63, lowercase: true, allowedPattern: /[^a-z0-9.-]/g }),
  },
  'AWS::Scheduler::Schedule': {
    file: 'scheduler-schedule-provider.ts',
    source: 'generateResourceName(logicalId, { maxLength: 64 })',
    derive: (id) => generateResourceName(id, { maxLength: 64 }),
  },
  'AWS::SSM::Parameter': {
    file: 'ssm-parameter-provider.ts',
    source:
      '`/${generateResourceName(logicalId, { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`',
    derive: (id) =>
      `/${generateResourceName(id, { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`,
  },
};

/** The derived-generation table, for the test that pins it to the providers. */
export function replacementDerivedGeneratedNames(): Readonly<
  Record<
    string,
    { readonly file: string; readonly source: string; derive(logicalId: string): string }
  >
> {
  return DERIVED_GENERATED_NAMES;
}

/** The Route 53 record-set rule: see {@link reverseReplacementNewHoldsName}. */
function recordSetHolds(
  requested: Record<string, unknown>,
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  newPhysicalId: string,
  r: Renderer,
  v: Voice
): ReverseReplacementHolderVerdict {
  const newRecord = `${v.holderRecord} (${r.shown(newPhysicalId)})`;
  const wantName = valueAt(requested, ['Name']);
  const wantType = valueAt(requested, ['Type']);
  const haveName = heldAt(recorded, observed, ['Name']).value;
  const haveType = heldAt(recorded, observed, ['Type']).value;
  if (wantName === undefined || wantType === undefined) {
    return unproven(`cdkd cannot read the Name and Type ${v.createdRecord} asked for`);
  }
  const wanted = `${v.create} asked for Name ${r.quoted(wantName)}`;
  if (haveName === undefined || haveType === undefined) {
    return unproven(`${wanted}, and cdkd cannot read the name ${newRecord} holds`);
  }
  if (dnsFold(wantName) !== dnsFold(haveName)) {
    // A `\ddd` escape spells one name two ways; decoding it is the provider's
    // business, so an escaped pair that differs is undecided, not different.
    return /\\[0-9]{3}/.test(wantName + haveName)
      ? unproven(`${wanted}, and cdkd cannot compare it with the escaped name ${newRecord} holds`)
      : elsewhere(`${wanted}, while ${newRecord} holds Name ${r.quoted(haveName)}`);
  }
  const wantZoneId = valueAt(requested, ['HostedZoneId']);
  const haveZoneId = heldAt(recorded, observed, ['HostedZoneId']).value;
  const wantZoneName = valueAt(requested, ['HostedZoneName']);
  const haveZoneName = heldAt(recorded, observed, ['HostedZoneName']).value;
  const sameZone =
    wantZoneId !== undefined && haveZoneId !== undefined
      ? zoneIdFold(wantZoneId) === zoneIdFold(haveZoneId)
      : wantZoneName !== undefined && haveZoneName !== undefined
        ? dnsFold(wantZoneName) === dnsFold(haveZoneName)
        : undefined;
  if (sameZone === false)
    return elsewhere(`${wanted}, while ${newRecord} is in another hosted zone`);
  if (sameZone === undefined) {
    return unproven(
      `${wanted}, and cdkd cannot tell whether ${newRecord} is in the same hosted zone`
    );
  }
  const wantSet = valueAt(requested, ['SetIdentifier']);
  const haveSet = heldAt(recorded, observed, ['SetIdentifier']).value;
  const wantCname = wantType.toUpperCase() === 'CNAME';
  const haveCname = haveType.toUpperCase() === 'CNAME';
  // A CNAME conflicts with every record of its name that is NOT a CNAME; two
  // CNAMEs of one name coexist under different SetIdentifiers.
  if (wantCname !== haveCname) return HOLDS;
  if (wantType.toUpperCase() !== haveType.toUpperCase()) {
    return elsewhere(
      `${wanted} of Type ${r.quoted(wantType)}, while ${newRecord} is a ${r.quoted(haveType)} ` +
        `record of that name`
    );
  }
  if ((wantSet === undefined) !== (haveSet === undefined)) {
    return unproven(
      `${wanted}, and only one of the two records carries a SetIdentifier, so cdkd cannot ` +
        `tell whether ${newRecord} holds it`
    );
  }
  return wantSet === haveSet
    ? HOLDS
    : elsewhere(`${wanted}, while ${newRecord} is a different record set of that name`);
}

/** The raw value at `path`, whatever it is. */
function pathValue(bag: Record<string, unknown> | undefined, path: readonly string[]): unknown {
  let node: unknown = bag;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * The `SENT_NAME_REWRITTEN` rule: see {@link reverseReplacementNewHoldsName}.
 * Called in the re-create's own async scope, so the generator reads the same
 * stack name and prefix flag the provider's create just read. On EITHER route
 * the records' names are never compared: the NEW resource may have been made
 * through the SDK provider (a replacement routes afresh, so an old
 * `cc-api` record can sit beside a new SDK one), whose rewritten name its
 * template-valued record does not show. A Cloud Control re-create sends its
 * bag verbatim, so there the sent name is the requested one.
 */
function rewrittenNameHolds(
  input: {
    requested: Record<string, unknown>;
    physicalId: string;
    logicalId?: unknown;
    oldResourceType: string;
    mask?: ((value: string) => string) | undefined;
  },
  rewrite: { readonly property: string; readonly maxLength: number },
  viaCloudControl: boolean,
  labels: string,
  newResource: string,
  r: Renderer,
  v: Voice
): ReverseReplacementHolderVerdict {
  const declared = valueAt(input.requested, [rewrite.property]);
  const logicalId =
    typeof input.logicalId === 'string' && input.logicalId !== '' ? input.logicalId : undefined;
  if (declared === undefined && (viaCloudControl || logicalId === undefined)) {
    return unproven(
      `${v.create} named no ${labels}, and cdkd cannot derive the name its provider generates, ` +
        `so it cannot show that ${newResource} holds it`
    );
  }
  const sent = viaCloudControl
    ? (declared as string)
    : generateResourceNameWithFallback(declared, logicalId ?? '', {
        maxLength: rewrite.maxLength,
      });
  if (sent === '') {
    return unproven(
      `the name ${v.create} sends for ${labels} is empty, so cdkd cannot show that ` +
        `${newResource} holds it`
    );
  }
  // The provider rewrites the name (prefix, charset, truncation), so a masker
  // matching the declared value may not match what it became: a declared
  // value the mask touches is never followed by its derived spelling.
  const secretDerived =
    declared !== undefined && (input.mask ?? ((value) => value))(declared) !== declared;
  const prop = r.shown(rewrite.property);
  const wanted =
    declared === undefined
      ? `${v.create} named no ${labels}, and its provider generates ${prop} ${r.quoted(sent)} here`
      : viaCloudControl
        ? `${v.create} asked for ${prop} ${r.quoted(declared)}`
        : secretDerived
          ? `${v.create} asked for ${prop} ${r.quoted(declared)}, which its provider rewrites before ` +
            `sending it`
          : `${v.create} asked for ${prop} ${r.quoted(declared)}, which its provider sends as ` +
            `${r.quoted(sent)} here`;
  const fold = CASE_INSENSITIVE_NAME_TYPES.has(input.oldResourceType)
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value;
  if (input.physicalId !== '' && holderIdNames(fold(input.physicalId), fold(sent))) return HOLDS;
  return unproven(
    // No apostrophe in a diagnosis: it is printed on the rollback refusal's
    // `Collision diagnosis:` line beside JSON-quoted names, and an odd `'`
    // pairs with one inside them when pasted (go-to-k/cdkd#4265).
    `${wanted}, and cdkd cannot show that ${newResource} holds that name (the provider of this ` +
      `type rewrites the names it sends, so a recorded name is no proof)`
  );
}

/**
 * Does the NEW resource of a replacement hold the name the rollback's re-create
 * of the OLD resource collided on? (issue
 * [#3979](https://github.com/go-to-k/cdkd/issues/3979))
 *
 * The reverse-replacement arm deletes the new resource first to free that
 * name. That is right only when the new resource holds it; a collision with
 * anything else — an orphan an earlier failed create left, a replayed create,
 * a resource made outside the stack — would delete a live resource that never
 * held the name, and the re-create would collide again. The collision
 * classifier cannot tell these apart, so this answers from the two records.
 *
 * The inverse polarity of {@link replacementRequestsDifferentName}: that one
 * answers only a KNOWN difference, because its positive answer refuses a
 * delete the user opted into; this one must PROVE the holder, because its
 * negative answer is what keeps an unasked delete from running. Anything it
 * cannot decide is `holds: false`, so nothing here may fold two values that
 * could name two resources (case, an ARN against a bare name).
 *
 * - The name the re-create asked for is read from `requested`, by the OLD
 *   type's name key: the generic rule is {@link explicitNamePropertyFor}'s
 *   property, overridden per type in `REVERSE_REPLACEMENT_NAME_KEYS` for a
 *   nested name or a name placed by a parent (`scope`). With none there, the
 *   `generated` bag's name counts — cdkd's own generation, which some SDK
 *   providers do not mint verbatim (a prefix, or no rule at all), so a
 *   mismatch on a generated name is undecided, never "elsewhere".
 * - The new resource holds it when its recorded (then observed) value of the
 *   same key is the same name, or — for the name alone — when its physical id
 *   names it (the deploy side's rule: equal, a final segment after `|`, or
 *   after `:` / `/` in an ARN or URL; plus the ELBv2 ARN's name segment), the
 *   proof for a generated name, which a recorded bag never holds. Names
 *   compare exactly, except for `CASE_INSENSITIVE_NAME_TYPES`. Every scope
 *   value must be exactly equal (absent on both sides counts as equal, and an
 *   ARN against a bare value is undecided).
 * - `AWS::Route53::RecordSet` compares the zone and the DNS name; then a CNAME
 *   beside a non-CNAME holds, and two records of one kind need the same type
 *   and SetIdentifier.
 * - A type in `SENT_NAME_REWRITTEN`: its SDK provider derives the name it
 *   sends (stack prefix, charset folding, truncation), so the records' names
 *   are never compared, on either route. The sent name is derived here, in the
 *   caller's scope, with the provider's own generator (on a Cloud Control
 *   route it is the requested one), and only the new resource's physical id
 *   naming it proves a holder.
 * - A `Type` change holds only between types that share one name space
 *   (`SHARED_NAME_SPACES`); any other pair is undecided. A type in
 *   `NOT_NAME_KEYED_TYPES`, or one with no name key at all, never holds.
 * - A redacted value or an unresolved dynamic reference is not a name.
 */
export function reverseReplacementNewHoldsName(
  input: ReverseReplacementHolderInput
): ReverseReplacementHolderVerdict {
  return holderVerdict(input, ROLLBACK_VOICE);
}

/** The input of {@link reverseReplacementNewHoldsName}. */
export interface ReverseReplacementHolderInput {
  oldResourceType: string;
  newResourceType: string;
  /** The bag the re-create of the OLD resource was built from. */
  requested: Record<string, unknown>;
  /** `requested` with the name cdkd generates filled in, for a nameless bag. */
  generated?: Record<string, unknown> | undefined;
  /** The NEW resource's recorded properties. */
  recorded: Record<string, unknown> | undefined;
  /** The NEW resource's observed properties. */
  observed: Record<string, unknown> | undefined;
  /** The NEW resource's physical id. */
  physicalId: string;
  /** The op's logical id: a `SENT_NAME_REWRITTEN` provider derives a nameless create's name from it. */
  logicalId?: unknown;
  /**
   * The route the re-create took. Absent reads as an SDK route, the one
   * that REWRITES names — the side that refuses more.
   */
  createdVia?: ProvisionedBy | undefined;
  /** The route the holder was created through (its record's `provisionedBy`). */
  holderVia?: ProvisionedBy | undefined;
  /**
   * Masks a value before it is rendered (the replay bag is plaintext). The
   * caller still masks the whole message; this runs first, on the raw value.
   */
  mask?: ((value: string) => string) | undefined;
}

/**
 * The one rule behind both directions. Named for the rollback's direction:
 * `oldResourceType` / `requested` / `generated` / `createdVia` describe the
 * CREATE that collided, `newResourceType` / `recorded` / `observed` /
 * `physicalId` the HOLDER; `v` says who they are in the diagnosis.
 */
function holderVerdict(
  input: ReverseReplacementHolderInput,
  v: Voice
): ReverseReplacementHolderVerdict {
  const { oldResourceType, newResourceType, requested, recorded, observed, physicalId } = input;
  const r = renderer(input.mask ?? ((value) => value));
  const newResource = `${v.holder} (${r.shown(physicalId)})`;
  if (
    oldResourceType !== newResourceType &&
    !SHARED_NAME_SPACES.some((s) => s.has(oldResourceType) && s.has(newResourceType))
  ) {
    return unproven(
      `${newResource} is of type ${r.shown(newResourceType)}, which cdkd does not know to share ` +
        `a name space with ${r.shown(oldResourceType)}`
    );
  }
  if (oldResourceType === RECORD_SET) {
    return recordSetHolds(requested, recorded, observed, physicalId, r, v);
  }
  const oldKey = nameKeyFor(oldResourceType);
  const newKey = nameKeyFor(newResourceType);
  if (oldKey === undefined || newKey === undefined) {
    if (
      // A Type change never reaches here: the check above refuses every pair
      // outside `SHARED_NAME_SPACES`, whose types all have name keys.
      v.identityFallback &&
      input.createdVia === 'cc-api' &&
      input.holderVia === 'cc-api' &&
      reverseReplacementNameKeyKind(oldResourceType) === 'unknown' &&
      sentIdentifierIs(requested, recorded, observed, physicalId)
    ) {
      return HOLDS;
    }
    // The one shape the identity rule would have proven but for a record
    // that predates cdkd recording its route: still refused, with the reason.
    const legacyRecord =
      v.identityFallback &&
      input.createdVia === 'cc-api' &&
      input.holderVia === undefined &&
      reverseReplacementNameKeyKind(oldResourceType) === 'unknown' &&
      sentIdentifierIs(requested, recorded, observed, physicalId);
    return unproven(
      `cdkd has no name property to compare for a ${r.shown(oldResourceType)}, so it cannot ` +
        `show that ${newResource} holds the colliding name` +
        (legacyRecord
          ? ` (its state record, written by an older cdkd, does not say it was created through ` +
            `Cloud Control, which is what would let its identifier prove it)`
          : '')
    );
  }
  const labels = oldKey.name.map((p) => r.shown(p.join('.'))).join(' / ');
  const unreadable = oldKey.name.find((path) => unreadableAt(requested, path));
  if (unreadable !== undefined) {
    return unproven(
      `the name ${v.create} asked for is ` +
        (pathValue(requested, unreadable) === ''
          ? `empty`
          : `redacted, unresolved or not a string`) +
        `, so cdkd cannot compare it with ${newResource}`
    );
  }
  const rewrite = ownEntry(SENT_NAME_REWRITTEN, oldResourceType);
  if (rewrite !== undefined) {
    return rewrittenNameHolds(
      input,
      rewrite,
      input.createdVia === 'cc-api',
      labels,
      newResource,
      r,
      v
    );
  }
  let generatedName = false;
  let namePath = oldKey.name.find((path) => valueAt(requested, path) !== undefined);
  let wantName = namePath === undefined ? undefined : valueAt(requested, namePath);
  if (
    namePath === undefined &&
    input.generated !== undefined &&
    reverseReplacementTrustsGeneratedName(oldResourceType)
  ) {
    namePath = oldKey.name.find((path) => valueAt(input.generated, path) !== undefined);
    wantName = namePath === undefined ? undefined : valueAt(input.generated, namePath);
    generatedName = wantName !== undefined;
  }
  const derived = ownEntry(DERIVED_GENERATED_NAMES, oldResourceType);
  const derivedName =
    namePath === undefined &&
    v.derivedNames &&
    derived !== undefined &&
    input.createdVia !== 'cc-api' &&
    typeof input.logicalId === 'string' &&
    input.logicalId !== ''
      ? derived.derive(input.logicalId)
      : '';
  if (derivedName !== '') {
    namePath = oldKey.name[0];
    wantName = derivedName;
    generatedName = true;
  }
  if (namePath === undefined || wantName === undefined) {
    return unproven(
      `${v.create} named no ${labels} (its provider picks one), so cdkd cannot show that ` +
        `${newResource} holds it`
    );
  }
  const wanted = generatedName
    ? `${v.create} named no ${labels}, and the cdkd naming rule generates ` +
      `${r.shown(namePath.join('.'))} ${r.quoted(wantName)} for it`
    : `${v.create} asked for ${r.shown(namePath.join('.'))} ${r.quoted(wantName)}`;
  const same = CASE_INSENSITIVE_NAME_TYPES.has(oldResourceType)
    ? (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string): boolean => a === b;
  const inCase = CASE_INSENSITIVE_NAME_TYPES.has(oldResourceType)
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value;
  // A record and a read-back that name the holder DIFFERENTLY (renamed out
  // of band, or a drifted record) cannot say which name it holds now: the
  // physical id would still name the recorded one. Undecided, in both
  // directions.
  const drifted = newKey.name.find((path) => {
    const recordedName = valueAt(recorded, path);
    const observedName = valueAt(observed, path);
    return (
      recordedName !== undefined && observedName !== undefined && !same(recordedName, observedName)
    );
  });
  if (drifted !== undefined) {
    return unproven(
      `${wanted}, and the records of ${newResource} disagree on its ` +
        `${r.shown(drifted.join('.'))} (recorded ${r.quoted(valueAt(recorded, drifted) ?? '')}, ` +
        `read back ${r.quoted(valueAt(observed, drifted) ?? '')}), so cdkd cannot show which name ` +
        `it holds`
    );
  }
  const held = newKey.name.map((path) => heldAt(recorded, observed, path));
  const haveName = held.find((h) => h.value !== undefined)?.value;
  const nameHeld =
    (haveName !== undefined && same(haveName, wantName)) ||
    (physicalId !== '' && holderIdNames(inCase(physicalId), inCase(wantName)));
  if (!nameHeld) {
    return haveName !== undefined && !generatedName
      ? elsewhere(`${wanted}, while ${newResource} holds ${r.quoted(haveName)}`)
      : unproven(`${wanted}, and cdkd cannot show that ${newResource} holds that name`);
  }
  for (const [i, path] of (oldKey.scope ?? []).entries()) {
    const label = r.shown(path.join('.'));
    const wantRaw = valueAt(requested, path);
    const have = heldAt(recorded, observed, path);
    if ((wantRaw === undefined && unreadableAt(requested, path)) || have.unreadable) {
      return unproven(`${wanted}, and cdkd cannot read the ${label} that places it`);
    }
    const fallback = oldKey.scopeDefaults?.[i];
    const want = wantRaw ?? fallback;
    const got = have.value ?? fallback;
    if (want === undefined && got === undefined) continue;
    if (want === undefined || got === undefined) {
      return unproven(`${wanted}, and cdkd cannot show that ${newResource} shares its ${label}`);
    }
    if (want === got) continue;
    // One scope spelled as an ARN on one side and a bare name on the other
    // may be the same parent: undecided rather than "elsewhere".
    if (isArn(want) !== isArn(got)) {
      return unproven(
        `${wanted}, and cdkd cannot tell whether ${label} ${r.quoted(got)} is ${r.quoted(want)}`
      );
    }
    return elsewhere(
      `${wanted}, while ${newResource} is under ${label} ${r.quoted(got)}, not ${r.quoted(want)}`
    );
  }
  return HOLDS;
}

/**
 * Does the OLD resource of a replacement hold the name the replacement's
 * create-first attempt collided on? The deploy-direction twin of
 * {@link reverseReplacementNewHoldsName} (issue
 * [#3979](https://github.com/go-to-k/cdkd/issues/3979)), with the same rule,
 * tables and sent-name derivation, the two resources swapped.
 *
 * `cdkd deploy --replace` deletes the old resource first to free that name.
 * {@link replacementRequestsDifferentName} refuses only a KNOWN different
 * explicit name, so a template naming no name — or one a `SENT_NAME_REWRITTEN`
 * provider rewrites under the current stack scope and prefix flag — used to
 * delete the old resource on the classifier's word alone, though an orphan of
 * an earlier attempt, a replayed create or a squatter collides identically.
 * The delete-first runs only on `holds: true`; anything else refuses.
 *
 * Call it in the create's own async scope, like the rollback twin.
 */
export function replacementOldHoldsSentName(input: {
  /** The template's type: what the create routed on. */
  createType: string;
  /** The state record's type: the old resource's. */
  holderType: string;
  /** The bag the create was SENT (the Cloud Control one carries the generated name). */
  requested: Record<string, unknown>;
  /** `requested` with the name cdkd generates filled in, for a nameless bag. */
  generated?: Record<string, unknown> | undefined;
  /** The OLD resource's recorded properties. */
  recorded: Record<string, unknown> | undefined;
  /** The OLD resource's observed properties. */
  observed: Record<string, unknown> | undefined;
  /** The OLD resource's physical id. */
  physicalId: string;
  logicalId?: unknown;
  /** The route the create took. */
  createdVia?: ProvisionedBy | undefined;
  /** The old resource's recorded `provisionedBy`. */
  holderVia?: ProvisionedBy | undefined;
  mask?: ((value: string) => string) | undefined;
}): ReverseReplacementHolderVerdict {
  return holderVerdict(
    {
      oldResourceType: input.createType,
      newResourceType: input.holderType,
      requested: input.requested,
      generated: input.generated,
      recorded: input.recorded,
      observed: input.observed,
      physicalId: input.physicalId,
      logicalId: input.logicalId,
      createdVia: input.createdVia,
      holderVia: input.holderVia,
      mask: input.mask,
    },
    DEPLOY_VOICE
  );
}

/**
 * The shared diagnosis sentence. Each caller appends its own remedy, since what
 * deleting the old resource first means differs per site (`--replace`, or
 * removing `UpdateReplacePolicy: Retain`).
 *
 * The names are template text and `state.json` values, and the remedy names
 * `cdkd deploy --replace`, so none goes inside cdkd's own `"..."` unless it is
 * a plain identifier (go-to-k/cdkd#3950): a `"` in it closed the quote, and
 * `$( )` or a backtick runs inside double quotes regardless. Any other value
 * is described.
 */
export function renderNameHeldElsewhere(change: ReplacementNameChange): string {
  const property = change.property;
  const desiredPlain = isPlainName(change.desiredName);
  const asksFor = desiredPlain
    ? `asks for ${property} "${change.desiredName}"`
    : `asks for a name (${property}) that is not a plain identifier`;
  const heldProperty = change.heldProperty ?? property;
  const held =
    change.heldName === undefined
      ? `does not hold that name`
      : isPlainName(change.heldName)
        ? `holds ${heldProperty} "${change.heldName}"`
        : `holds a name (${heldProperty}) that is not a plain identifier`;
  const replaced =
    change.physicalId === ''
      ? 'the resource being replaced, which has no recorded id,'
      : isPlainName(change.physicalId)
        ? `the resource being replaced (${change.physicalId})`
        : 'the resource being replaced, whose recorded id is not a plain identifier,';
  // The desired name's second mention: `"name"` when plain, else `the
  // requested name`, which cannot bind to a described held name nearer to it.
  return (
    `The replacement ${asksFor}, but ${replaced} ${held} — so ` +
    `${desiredPlain ? `"${change.desiredName}"` : 'the requested name'} is held by ANOTHER existing ` +
    `resource, not by the one being replaced, and deleting the old resource first cannot free it`
  );
}

/**
 * True when `value` has no whitespace and `displayIdent` renders it unchanged:
 * only characters that are literal inside double quotes. The whitespace test
 * comes FIRST because the round-trip alone admits a value that ends in
 * `displayIdent`'s own cut marker (`<1152 plain characters> [cut: N more
 * characters withheld]` renders as itself). The cap is the stack-ref one, so a
 * long ARN physical id is not cut.
 */
function isPlainName(value: string): boolean {
  return (
    !/\s/.test(value) && displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === value
  );
}
