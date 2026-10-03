import type { ProvisionedBy } from '../../provisioning/provider-registry.js';
import { explicitNamePropertyFor } from '../../provisioning/resource-name.js';
import { SECRET_MASK } from '../secret-redaction.js';
import { renderNameHeldElsewhere, isPlainName } from './holder.js';
import { CASE_INSENSITIVE_NAME_TYPES } from './name-keys.js';

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

export function nameValue(
  bag: Record<string, unknown> | undefined,
  property: string
): string | undefined {
  const value = bag?.[property];
  if (typeof value !== 'string' || value === '' || value === SECRET_MASK) return undefined;
  if (value.includes('{{resolve:')) return undefined;
  return value;
}

/** Does `physicalId` name `desired` (both folded alike)? See the module doc. */
export function physicalIdNames(physicalId: string, desired: string): boolean {
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
 * `getAccountInfo`, which refuses when STS is unreachable (issue #1730), and a
 * lookup of a made-up ARN would answer "free".
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
 * `'name'` for a name carrying `:`, `'account'` for a malformed account id or
 * an empty region — a lookup of a made-up ARN answers "free". (An account STS
 * could not name never gets here: `getAccountInfo` refuses, issue #1730.)
 */
export function createLookupArn(
  resourceType: string,
  name: string,
  account: { partition: string; region: string; accountId: string }
): { arn: string } | { unbuildable: 'name' | 'account' } | undefined {
  const shape = CREATE_LOOKUP_ARN[resourceType];
  if (shape === undefined) return undefined;
  if (name.includes(':')) return { unbuildable: 'name' };
  if (!/^\d{12}$/.test(account.accountId) || account.region === '') {
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
