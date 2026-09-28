/**
 * Who holds a replacement's colliding name. Two questions, one per direction:
 * {@link replacementRequestsDifferentName} (deploy) and
 * {@link reverseReplacementNewHoldsName} (rollback, further down).
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

import { explicitNamePropertyFor } from '../provisioning/resource-name.js';
import { displayIdent, displaySafe } from '../utils/display-safe.js';
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

/** Does `physicalId` name `desired` (both lower-cased)? See the module doc. */
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
}): ReplacementNameChange | undefined {
  const property = explicitNamePropertyFor(input.newResourceType);
  if (property === undefined) return undefined;
  const desiredName = nameValue(input.desiredProperties, property);
  if (desiredName === undefined) return undefined;
  const desired = desiredName.toLowerCase();

  const oldProperty = explicitNamePropertyFor(input.oldResourceType);
  const heldName =
    oldProperty === undefined
      ? undefined
      : (nameValue(input.recorded, oldProperty) ?? nameValue(input.observed, oldProperty));

  const physicalId = input.physicalId.toLowerCase();
  if (heldName !== undefined && heldName.toLowerCase() === desired) return undefined;
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
 * parent only through the anchor residual in `retryable-errors.ts`).
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
 * Types whose SDK provider does NOT mint `applyDefaultNameForFallback`'s name
 * verbatim (a log group gets `/cdkd/<name>`, an SSM parameter `/<name>`), so
 * the `generated` bag is not what their create sent and proves nothing — not
 * even a match. Fenced against the providers' wrapped generation sites.
 */
const GENERATED_NAME_DIVERGES: ReadonlySet<string> = new Set([
  'AWS::Logs::LogGroup',
  'AWS::SSM::Parameter',
]);

/** The case-insensitive name spaces, for the test that pins the list. */
export function reverseReplacementCaseInsensitiveTypes(): readonly string[] {
  return [...CASE_INSENSITIVE_NAME_TYPES].sort();
}

/** Does cdkd's generation rule name what this type's nameless create sends? */
export function reverseReplacementTrustsGeneratedName(resourceType: string): boolean {
  return !GENERATED_NAME_DIVERGES.has(resourceType);
}

/**
 * Pairs of DIFFERENT types that share one name space, so across a `Type`
 * change the new resource can hold the old one's name.
 */
const SHARED_NAME_SPACES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable']),
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
  const own = REVERSE_REPLACEMENT_NAME_KEYS[resourceType];
  if (own !== undefined) return own;
  const property = explicitNamePropertyFor(resourceType);
  return property === undefined ? undefined : flat(property);
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

/** The Route 53 record-set rule: see {@link reverseReplacementNewHoldsName}. */
function recordSetHolds(
  requested: Record<string, unknown>,
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  newPhysicalId: string,
  r: Renderer
): ReverseReplacementHolderVerdict {
  const newRecord = `the new record (${r.shown(newPhysicalId)})`;
  const wantName = valueAt(requested, ['Name']);
  const wantType = valueAt(requested, ['Type']);
  const haveName = heldAt(recorded, observed, ['Name']).value;
  const haveType = heldAt(recorded, observed, ['Type']).value;
  if (wantName === undefined || wantType === undefined) {
    return unproven(`cdkd cannot read the Name and Type the re-created record asked for`);
  }
  const wanted = `the re-create asked for Name ${r.quoted(wantName)}`;
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
 * - A `Type` change holds only between types that share one name space
 *   (`SHARED_NAME_SPACES`). A type in `NOT_NAME_KEYED_TYPES`, or one with no
 *   name key at all, never holds.
 * - A redacted value or an unresolved dynamic reference is not a name.
 */
export function reverseReplacementNewHoldsName(input: {
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
  /**
   * Masks a value before it is rendered (the replay bag is plaintext). The
   * caller still masks the whole message; this runs first, on the raw value.
   */
  mask?: ((value: string) => string) | undefined;
}): ReverseReplacementHolderVerdict {
  const { oldResourceType, newResourceType, requested, recorded, observed, physicalId } = input;
  const r = renderer(input.mask ?? ((value) => value));
  const newResource = `the new resource (${r.shown(physicalId)})`;
  if (
    oldResourceType !== newResourceType &&
    !SHARED_NAME_SPACES.some((s) => s.has(oldResourceType) && s.has(newResourceType))
  ) {
    return elsewhere(
      `${newResource} is a ${r.shown(newResourceType)}, which does not share a name space ` +
        `with ${r.shown(oldResourceType)}`
    );
  }
  if (oldResourceType === RECORD_SET) {
    return recordSetHolds(requested, recorded, observed, physicalId, r);
  }
  const oldKey = nameKeyFor(oldResourceType);
  const newKey = nameKeyFor(newResourceType);
  if (oldKey === undefined || newKey === undefined) {
    return unproven(
      `cdkd has no name property to compare for a ${r.shown(oldResourceType)}, so it cannot ` +
        `show that ${newResource} holds the colliding name`
    );
  }
  const labels = oldKey.name.map((p) => r.shown(p.join('.'))).join(' / ');
  if (oldKey.name.some((path) => unreadableAt(requested, path))) {
    return unproven(
      `the name the re-create asked for is redacted or unresolved, so cdkd cannot compare it ` +
        `with ${newResource}`
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
  if (namePath === undefined || wantName === undefined) {
    return unproven(
      `the re-create named no ${labels} (its provider picks one), so cdkd cannot show that ` +
        `${newResource} holds it`
    );
  }
  const wanted = generatedName
    ? `the re-create named no ${labels}, and cdkd's rule generates ` +
      `${r.shown(namePath.join('.'))} ${r.quoted(wantName)} for it`
    : `the re-create asked for ${r.shown(namePath.join('.'))} ${r.quoted(wantName)}`;
  const same = CASE_INSENSITIVE_NAME_TYPES.has(oldResourceType)
    ? (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    : (a: string, b: string): boolean => a === b;
  const inCase = CASE_INSENSITIVE_NAME_TYPES.has(oldResourceType)
    ? (v: string): string => v.toLowerCase()
    : (v: string): string => v;
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
 * The shared diagnosis sentence. Each caller appends its own remedy, since what
 * deleting the old resource first means differs per site (`--replace`, or
 * removing `UpdateReplacePolicy: Retain`).
 */
export function renderNameHeldElsewhere(change: ReplacementNameChange): string {
  const desired = displaySafe(change.desiredName);
  const held =
    change.heldName !== undefined
      ? `holds ${change.heldProperty ?? change.property} "${displaySafe(change.heldName)}"`
      : `does not hold that name`;
  return (
    `The replacement asks for ${change.property} "${desired}", but the resource being ` +
    `replaced (${displaySafe(change.physicalId)}) ${held} — so "${desired}" is held by ` +
    `ANOTHER existing resource, not by the one being replaced, and deleting the old ` +
    `resource first cannot free it`
  );
}
