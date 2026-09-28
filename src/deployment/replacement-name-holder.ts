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
 * Types a create never collides on by NAME, so no name proves a holder: the
 * name is not unique (Route 53 hosted zones, ACM certificates, EMR clusters,
 * Cognito user pools), the write is an upsert (an inline IAM policy), or the
 * name-shaped create-only property names a PARENT, not the resource. A
 * collision on one of these is never the new resource's, and is refused.
 */
const NOT_NAME_KEYED_TYPES: ReadonlySet<string> = new Set([
  'AWS::CertificateManager::Certificate',
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
 * Pairs of DIFFERENT types that share one name space, so across a `Type`
 * change the new resource can hold the old one's name.
 */
const SHARED_NAME_SPACES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable']),
];

const RECORD_SET = 'AWS::Route53::RecordSet';

/**
 * A nested stack's child is named `<parent>~<logicalId>` whatever its
 * properties say (`NestedStackProvider`), so both halves of its replacement
 * carry the one name by construction.
 */
const NESTED_STACK = 'AWS::CloudFormation::Stack';

/** How {@link reverseReplacementNewHoldsName} reads a type's name. */
export function reverseReplacementNameKeyKind(
  resourceType: string
): 'keyed' | 'record-set' | 'logical-id' | 'not-name-keyed' | 'unknown' {
  if (resourceType === RECORD_SET) return 'record-set';
  if (resourceType === NESTED_STACK) return 'logical-id';
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

/** A path's value in the recorded bag, else in the observed one. */
function heldAt(
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  path: readonly string[]
): string | undefined {
  return valueAt(recorded, path) ?? valueAt(observed, path);
}

/** Is `bag` carrying a secret mask or an unresolved reference at `path`? */
function unreadableAt(bag: Record<string, unknown> | undefined, path: readonly string[]): boolean {
  let node: unknown = bag;
  for (const segment of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return node !== undefined && node !== null && valueAt(bag, path) === undefined;
}

const fold = (value: string): string => value.toLowerCase();

/**
 * Does `physicalId` name `name` (both lower-cased)? The deploy side's rule
 * ({@link physicalIdNames}), plus the ELBv2 ARN, whose name segment is
 * followed by a generated id (`...:targetgroup/<name>/<id>`,
 * `...:loadbalancer/app/<name>/<id>`) — the one id a same-name replacement
 * CHANGES, so the only one a same-name reverse-replacement ever meets.
 */
function holderIdNames(physicalId: string, name: string): boolean {
  if (physicalIdNames(physicalId, name)) return true;
  const elbv2 =
    /^arn:[^:]+:elasticloadbalancing:[^:]*:[^:]*:(?:targetgroup|loadbalancer\/(?:app|net|gwy))\/([^/]+)\/[^/]+$/.exec(
      physicalId
    );
  return elbv2 !== null && elbv2[1] === name;
}

/** A Route 53 name or zone name, compared without its trailing dot. */
const dnsFold = (value: string): string => fold(value).replace(/\.$/, '');

/** A hosted zone id, with or without its `/hostedzone/` prefix. */
const zoneIdFold = (value: string): string => fold(value).replace(/^\/hostedzone\//, '');

/**
 * The verdict of {@link reverseReplacementNewHoldsName}. `holds: false`
 * carries a DISPLAY-SAFE `diagnosis` clause (every value through
 * `displayIdent`) naming the colliding name when it is known, and `known`:
 * `true` when the records show the new resource holds a DIFFERENT name (so
 * another resource holds the colliding one), `false` when they cannot decide.
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
 * An identifier as the refusal shows it: `displayIdent`, which quotes any
 * value that is not plain (padding, an invisible, a line break), since the
 * refusal ends on a pasteable `--orphan` line a forged value must not imitate.
 */
const shown = (value: string): string => displayIdent(value);

/** A name, in double quotes when `displayIdent` left it plain. */
function quoted(value: string): string {
  const rendered = displayIdent(value);
  return rendered === value ? `"${value}"` : rendered;
}

/** The Route 53 record-set rule: see {@link reverseReplacementNewHoldsName}. */
function recordSetHolds(
  requested: Record<string, unknown>,
  recorded: Record<string, unknown> | undefined,
  observed: Record<string, unknown> | undefined,
  newPhysicalId: string
): ReverseReplacementHolderVerdict {
  const newRecord = `the new record (${shown(newPhysicalId)})`;
  const wantName = valueAt(requested, ['Name']);
  const wantType = valueAt(requested, ['Type']);
  const haveName = heldAt(recorded, observed, ['Name']);
  const haveType = heldAt(recorded, observed, ['Type']);
  if (wantName === undefined || wantType === undefined) {
    return unproven(`cdkd cannot read the Name and Type the re-created record asked for`);
  }
  const wanted = `the re-create asked for Name ${quoted(wantName)}`;
  if (haveName === undefined || haveType === undefined) {
    return unproven(`${wanted}, and cdkd cannot read the name ${newRecord} holds`);
  }
  if (dnsFold(wantName) !== dnsFold(haveName)) {
    return elsewhere(`${wanted}, but ${newRecord} holds Name ${quoted(haveName)}`);
  }
  const wantZoneId = valueAt(requested, ['HostedZoneId']);
  const haveZoneId = heldAt(recorded, observed, ['HostedZoneId']);
  const wantZoneName = valueAt(requested, ['HostedZoneName']);
  const haveZoneName = heldAt(recorded, observed, ['HostedZoneName']);
  const sameZone =
    wantZoneId !== undefined && haveZoneId !== undefined
      ? zoneIdFold(wantZoneId) === zoneIdFold(haveZoneId)
      : wantZoneName !== undefined && haveZoneName !== undefined
        ? dnsFold(wantZoneName) === dnsFold(haveZoneName)
        : undefined;
  if (sameZone === false) return elsewhere(`${wanted}, but ${newRecord} is in another hosted zone`);
  if (sameZone === undefined) {
    return unproven(
      `${wanted}, and cdkd cannot tell whether ${newRecord} is in the same hosted zone`
    );
  }
  // A CNAME conflicts with every record of its name; any other record only
  // with one of the same type and SetIdentifier.
  if (fold(wantType) === 'cname' || fold(haveType) === 'cname') return HOLDS;
  const sameIdentity =
    fold(wantType) === fold(haveType) &&
    (valueAt(requested, ['SetIdentifier']) ?? '') ===
      (heldAt(recorded, observed, ['SetIdentifier']) ?? '');
  return sameIdentity
    ? HOLDS
    : elsewhere(
        `${wanted} of Type ${quoted(wantType)}, but ${newRecord} is a different record of that name`
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
 * cannot decide is `holds: false`.
 *
 * - The name the re-create asked for is read from the bag it sent
 *   (`requested`), by the OLD type's name key: the generic rule is
 *   {@link explicitNamePropertyFor}'s property, overridden per type in
 *   `REVERSE_REPLACEMENT_NAME_KEYS` for a nested name or a name placed by a
 *   parent (`scope`). A generated name counts when the caller filled it the
 *   way the provider generates it; a bag still nameless is undecidable.
 * - The new resource holds it when its recorded (then observed) value of the
 *   same key equals it, or — for the name alone — when its physical id names
 *   it (the deploy side's rule: equal, a final segment after `|`, or after `:`
 *   / `/` in an ARN or URL; plus the ELBv2 ARN's name segment) — the proof for
 *   a generated name, which a recorded bag never holds. Every scope value must also be equal (absent on
 *   both sides counts as equal). Names compare case-insensitively.
 * - `AWS::Route53::RecordSet` compares the zone and the DNS name, then the
 *   type and SetIdentifier unless either record is a CNAME, which conflicts
 *   with every record of its name. A nested stack is named from its logical
 *   id, so the new one always holds it.
 * - A `Type` change holds only between types that share one name space
 *   (`SHARED_NAME_SPACES`). A type in `NOT_NAME_KEYED_TYPES`, or one with no
 *   name key at all, never holds.
 * - A redacted value or an unresolved dynamic reference is not a name.
 */
export function reverseReplacementNewHoldsName(input: {
  oldResourceType: string;
  newResourceType: string;
  /**
   * The bag the re-create of the OLD resource sent, with any name its provider
   * generates filled in (`applyDefaultNameForFallback`, which mirrors the SDK
   * providers' own generation).
   */
  requested: Record<string, unknown>;
  /** The NEW resource's recorded properties. */
  recorded: Record<string, unknown> | undefined;
  /** The NEW resource's observed properties. */
  observed: Record<string, unknown> | undefined;
  /** The NEW resource's physical id. */
  physicalId: string;
}): ReverseReplacementHolderVerdict {
  const { oldResourceType, newResourceType, requested, recorded, observed, physicalId } = input;
  const newResource = `the new resource (${shown(physicalId)})`;
  if (
    oldResourceType !== newResourceType &&
    !SHARED_NAME_SPACES.some((s) => s.has(oldResourceType) && s.has(newResourceType))
  ) {
    return elsewhere(
      `${newResource} is a ${shown(newResourceType)}, which does not share a name space ` +
        `with ${shown(oldResourceType)}`
    );
  }
  if (oldResourceType === RECORD_SET) {
    return recordSetHolds(requested, recorded, observed, physicalId);
  }
  if (oldResourceType === NESTED_STACK) return HOLDS;
  const oldKey = nameKeyFor(oldResourceType);
  const newKey = nameKeyFor(newResourceType);
  if (oldKey === undefined || newKey === undefined) {
    return unproven(
      `cdkd does not know which property names a ${shown(oldResourceType)}, so it ` +
        `cannot show that ${newResource} holds the colliding name`
    );
  }
  const namePath = oldKey.name.find((path) => valueAt(requested, path) !== undefined);
  const wantName = namePath === undefined ? undefined : valueAt(requested, namePath);
  if (namePath === undefined || wantName === undefined) {
    return unproven(
      oldKey.name.some((path) => unreadableAt(requested, path))
        ? `the name the re-create asked for is redacted or unresolved, so cdkd cannot compare ` +
            `it with ${newResource}`
        : `the re-create asked for no ` +
            `${oldKey.name.map((p) => shown(p.join('.'))).join(' / ')}, so its name was ` +
            `generated, and cdkd cannot show that ${newResource} holds it`
    );
  }
  const wanted = `the re-create asked for ${shown(namePath.join('.'))} ${quoted(wantName)}`;
  const haveName = newKey.name
    .map((path) => heldAt(recorded, observed, path))
    .find((v) => v !== undefined);
  const nameHeld =
    (haveName !== undefined && fold(haveName) === fold(wantName)) ||
    (physicalId !== '' && holderIdNames(fold(physicalId), fold(wantName)));
  if (!nameHeld) {
    return haveName !== undefined
      ? elsewhere(`${wanted}, but ${newResource} holds ${quoted(haveName)}`)
      : unproven(`${wanted}, and cdkd cannot show that ${newResource} holds that name`);
  }
  for (const [i, path] of (oldKey.scope ?? []).entries()) {
    const label = shown(path.join('.'));
    const wantRaw = valueAt(requested, path);
    const haveRaw = heldAt(recorded, observed, path);
    if (
      (wantRaw === undefined && unreadableAt(requested, path)) ||
      (haveRaw === undefined && unreadableAt(recorded, path))
    ) {
      return unproven(`${wanted}, and cdkd cannot read the ${label} that places it`);
    }
    const fallback = oldKey.scopeDefaults?.[i];
    const want = wantRaw ?? fallback;
    const have = haveRaw ?? fallback;
    if (want === undefined && have === undefined) continue;
    if (want === undefined || have === undefined) {
      return unproven(`${wanted}, and cdkd cannot show that ${newResource} shares its ${label}`);
    }
    if (fold(want) !== fold(have)) {
      return elsewhere(
        `${wanted}, but ${newResource} is under ${label} ${quoted(have)}, not ${quoted(want)}`
      );
    }
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
