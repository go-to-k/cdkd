import { TemplateParser } from '../analyzer/template-parser.js';
import { takenFnIfArms } from './recreate-target-readers.js';

/**
 * go-to-k/cdkd#4411: resource types AWS stores INSIDE another resource, so
 * deleting that parent deletes them too, keyed by the type, with the
 * properties that name the parent and the parent types they may name.
 *
 * When a deploy destroys a parent and re-creates it under the SAME physical id
 * (a fixed-name Lambda function recreated by `--recreate-via-*`, or the
 * delete-first `--replace` of a property-driven replacement), such a child's
 * referencing property resolves to exactly what its record holds, so the
 * engine's no-op skip — or its lowered replacement ceiling — sent nothing, and
 * state kept a resource AWS no longer has. The engine re-creates it instead
 * ({@link childLostWithRecreatedParent}). A child naming SEVERAL parents
 * (`mode: 'reput'`) is updated in place instead, writing the policy to every
 * parent it names; a create without a delete would also have left the old
 * policy on a parent it dropped. Only the IAM `Policy` update removes it from
 * a dropped principal: the topic and queue policy updates never cleared a
 * dropped topic or queue, before this change or after it. A `reput` child
 * recorded on the Cloud Control route sends nothing still, as its patch from
 * record to template is empty; all three route through their SDK providers.
 *
 * The replacement arm records a parent, and so does the update-failure
 * fallback (`ResourceUpdateNotSupportedError` / Cloud Control
 * `UnsupportedAction` -> delete, create), go-to-k/cdkd#4444. The diff never
 * promoted the fallback parent's readers (it was an in-place row), so the
 * executor dispatches its `NO_CHANGE` children as soon as it completes
 * ({@link noChangeChildrenOfRecreatedParents}). A child the deploy fails
 * before reaching has its state record forgotten instead, so the next deploy
 * creates it ({@link lostChildActions}).
 *
 * A child is lost only when its parent-naming value is UNCHANGED (the caller
 * compares the resolved value with the record): one the same deploy re-points
 * from a surviving parent to the recreated one still holds its old copy on the
 * surviving parent, so it takes the ordinary replacement, which deletes that
 * copy. A parent named by a literal string (no `Ref` / `Fn::GetAtt` /
 * `Fn::Sub`) is not detected.
 *
 * Each entry is either stated by the service's own documentation or follows
 * from the child having no existence apart from the parent:
 *
 * - Lambda `Version` / `Alias`: `DeleteFunction` deletes "all versions and
 *   aliases" (Lambda API reference).
 * - Lambda `Permission`: a statement of the resource-based policy attached to
 *   the function, or to an alias or version of it (deleted with the function);
 *   `EventInvokeConfig`: the function's asynchronous invocation
 *   configuration, addressed by the function name.
 * - SNS `Subscription`: `DeleteTopic` "deletes a topic and all its
 *   subscriptions" (SNS API reference); `TopicPolicy`: the topic's `Policy`
 *   attribute.
 * - SNS `TopicInlinePolicy` ("associates one Amazon SNS topic with one
 *   policy", CloudFormation reference) and SQS `QueueInlinePolicy`: the one
 *   topic's or queue's `Policy` attribute.
 * - SQS `QueuePolicy`: the queue's `Policy` attribute (`SetQueueAttributes`).
 * - S3 `BucketPolicy`: the bucket's `policy` subresource.
 * - CloudWatch Logs `MetricFilter` / `SubscriptionFilter` / `LogStream`:
 *   identified by their name AND the log group they belong to;
 *   `DeleteLogGroup` deletes "all the archived log events associated with the
 *   log group" (CloudWatch Logs API reference).
 * - IAM `RolePolicy` / `UserPolicy` / `GroupPolicy`, and `Policy` through its
 *   `Roles` / `Users` / `Groups`:
 *   inline policies, which `DeleteRole` / `DeleteUser` / `DeleteGroup`
 *   require removing first (IAM API reference), so cdkd's role, user and
 *   group providers delete them before the principal.
 *
 * `mode: 'reattach'` (go-to-k/cdkd#4461): the child SURVIVES its parent, and
 * only its attachment to the parent is lost, because IAM refuses to delete a
 * principal that still has one (`DeleteConflict`), so every route detaches it
 * first. A re-create would collide on the child's name; the in-place update
 * re-attaches instead, from a recorded side with the re-created parents'
 * names dropped ({@link withRecreatedAttachmentsDropped}), so the provider's
 * own diff adds them back:
 * - IAM `ManagedPolicy` through `Roles` / `Users` / `Groups`
 *   (`AttachRolePolicy` / `AttachUserPolicy` / `AttachGroupPolicy`).
 * - IAM `InstanceProfile` through `Roles` (`AddRoleToInstanceProfile`).
 * - IAM `User` through `Groups`, and `UserToGroupAddition` through `Users`
 *   (`AddUserToGroup`): a group is deleted only once its members are removed.
 *   A `UserToGroupAddition` whose `GroupName` names the re-created group lost
 *   every member it added, so its whole recorded `Users` is dropped.
 *
 * Deliberately NOT listed:
 * - Lambda `EventSourceMapping`: `DeleteFunction` does not delete it (Lambda
 *   API reference: "use DeleteEventSourceMapping").
 * - Lambda `Url`: deleted ASYNCHRONOUSLY with the function, and the Lambda
 *   guide warns that a function re-created at once under the same name may
 *   inherit the old URL instead, so a re-create can collide.
 */
interface ChildEntry {
  readonly properties: readonly string[];
  readonly parentTypes: readonly string[];
  /**
   * `reput`: names several parents, so it is updated in place rather than
   * re-created. `reattach`: survives the parent, and its in-place update
   * attaches it to the re-created parent again.
   */
  readonly mode?: 'reput' | 'reattach';
  /**
   * The parent types each property may name, where they differ by property
   * (an IAM principal list names roles, users or groups by its key); absent,
   * every property may name any of `parentTypes`.
   */
  readonly byProperty?: Readonly<Record<string, readonly string[]>>;
  /**
   * `reattach` only: a property naming the parent itself (not a list of
   * attachments), mapped to the recorded list the parent's re-create emptied.
   */
  readonly clears?: Readonly<Record<string, string>>;
}

const LAMBDA_FUNCTION = 'AWS::Lambda::Function';
const IAM_ROLE = 'AWS::IAM::Role';
const IAM_USER = 'AWS::IAM::User';
const IAM_GROUP = 'AWS::IAM::Group';
const IAM_PRINCIPAL_TYPES = [IAM_ROLE, IAM_USER, IAM_GROUP];
const IAM_PRINCIPAL_LISTS = { Roles: [IAM_ROLE], Users: [IAM_USER], Groups: [IAM_GROUP] };

const CHILD_STORED_IN_PARENT: Readonly<Record<string, ChildEntry>> = {
  'AWS::Lambda::Permission': {
    properties: ['FunctionName'],
    parentTypes: [LAMBDA_FUNCTION, 'AWS::Lambda::Alias', 'AWS::Lambda::Version'],
  },
  'AWS::Lambda::EventInvokeConfig': {
    properties: ['FunctionName'],
    parentTypes: [LAMBDA_FUNCTION],
  },
  'AWS::Lambda::Version': { properties: ['FunctionName'], parentTypes: [LAMBDA_FUNCTION] },
  'AWS::Lambda::Alias': { properties: ['FunctionName'], parentTypes: [LAMBDA_FUNCTION] },
  'AWS::SNS::Subscription': { properties: ['TopicArn'], parentTypes: ['AWS::SNS::Topic'] },
  'AWS::SNS::TopicInlinePolicy': { properties: ['TopicArn'], parentTypes: ['AWS::SNS::Topic'] },
  'AWS::SQS::QueueInlinePolicy': { properties: ['Queue'], parentTypes: ['AWS::SQS::Queue'] },
  'AWS::Logs::LogStream': { properties: ['LogGroupName'], parentTypes: ['AWS::Logs::LogGroup'] },
  'AWS::SNS::TopicPolicy': {
    properties: ['Topics'],
    parentTypes: ['AWS::SNS::Topic'],
    mode: 'reput',
  },
  'AWS::SQS::QueuePolicy': {
    properties: ['Queues'],
    parentTypes: ['AWS::SQS::Queue'],
    mode: 'reput',
  },
  'AWS::S3::BucketPolicy': { properties: ['Bucket'], parentTypes: ['AWS::S3::Bucket'] },
  'AWS::Logs::MetricFilter': { properties: ['LogGroupName'], parentTypes: ['AWS::Logs::LogGroup'] },
  'AWS::Logs::SubscriptionFilter': {
    properties: ['LogGroupName'],
    parentTypes: ['AWS::Logs::LogGroup'],
  },
  'AWS::IAM::RolePolicy': { properties: ['RoleName'], parentTypes: ['AWS::IAM::Role'] },
  'AWS::IAM::UserPolicy': { properties: ['UserName'], parentTypes: [IAM_USER] },
  'AWS::IAM::GroupPolicy': { properties: ['GroupName'], parentTypes: [IAM_GROUP] },
  'AWS::IAM::Policy': {
    properties: ['Roles', 'Users', 'Groups'],
    parentTypes: IAM_PRINCIPAL_TYPES,
    byProperty: IAM_PRINCIPAL_LISTS,
    mode: 'reput',
  },
  'AWS::IAM::ManagedPolicy': {
    properties: ['Roles', 'Users', 'Groups'],
    parentTypes: IAM_PRINCIPAL_TYPES,
    byProperty: IAM_PRINCIPAL_LISTS,
    mode: 'reattach',
  },
  'AWS::IAM::InstanceProfile': { properties: ['Roles'], parentTypes: [IAM_ROLE], mode: 'reattach' },
  'AWS::IAM::User': { properties: ['Groups'], parentTypes: [IAM_GROUP], mode: 'reattach' },
  'AWS::IAM::UserToGroupAddition': {
    properties: ['GroupName', 'Users'],
    parentTypes: [IAM_GROUP, IAM_USER],
    byProperty: { GroupName: [IAM_GROUP], Users: [IAM_USER] },
    mode: 'reattach',
    clears: { GroupName: 'Users' },
  },
};

/** The parent types `property` of `entry` may name. */
function typesFor(entry: ChildEntry, property: string): readonly string[] {
  return entry.byProperty !== undefined && Object.hasOwn(entry.byProperty, property)
    ? entry.byProperty[property]!
    : entry.parentTypes;
}

/** Does `resourceType` survive its parent's re-create, losing only the attachment (`reattach`)? */
export function survivesParent(resourceType: string): boolean {
  return (
    Object.hasOwn(CHILD_STORED_IN_PARENT, resourceType) &&
    CHILD_STORED_IN_PARENT[resourceType]!.mode === 'reattach'
  );
}

/** The child types, for the test that pins the list. */
export function childStoredInParentTypes(): readonly string[] {
  return Object.keys(CHILD_STORED_IN_PARENT).sort();
}

// Built on first use, never at import: the parser takes a logger, and a test
// that mocks the logger module with a hoisted factory would read it before
// its own initialisation if any import of this module built one.
let parser: TemplateParser | undefined;

/**
 * The parent this deploy destroyed and re-created under the same physical id
 * that `resourceType` is stored inside, and how to restore the child:
 * `recreate` (created anew, the old one never deleted), `reput` (updated in
 * place, writing to every parent it names) or `reattach` (updated in place,
 * attaching it to the re-created parent again). `undefined` when it is no
 * such child.
 *
 * `recreatedUnderSameId` holds the parents; `recordedTypeOf` answers the
 * state record's type of a logical id, read by OWN key. Given the deploy's
 * evaluated `conditions`, an `Fn::If` reads only its taken arm, so a parent
 * named only on the untaken one does not count.
 */
export function childLostWithRecreatedParent(input: {
  resourceType: string;
  templateProperties: Record<string, unknown> | undefined;
  recreatedUnderSameId: ReadonlySet<string>;
  recordedTypeOf: (logicalId: string) => string | undefined;
  conditions?: Readonly<Record<string, boolean>> | undefined;
}): { parent: string; property: string; mode: 'recreate' | 'reput' | 'reattach' } | undefined {
  if (input.recreatedUnderSameId.size === 0) return undefined;
  if (!Object.hasOwn(CHILD_STORED_IN_PARENT, input.resourceType)) return undefined;
  const entry = CHILD_STORED_IN_PARENT[input.resourceType]!;
  const properties = input.templateProperties ?? {};
  for (const property of entry.properties) {
    if (!Object.hasOwn(properties, property)) continue;
    const value =
      input.conditions === undefined
        ? properties[property]
        : takenFnIfArms(properties[property], input.conditions);
    parser ??= new TemplateParser();
    for (const referencedId of parser.extractReferences(value)) {
      if (!input.recreatedUnderSameId.has(referencedId)) continue;
      const parentType = input.recordedTypeOf(referencedId);
      if (parentType !== undefined && typesFor(entry, property).includes(parentType)) {
        return { parent: referencedId, property, mode: entry.mode ?? 'recreate' };
      }
    }
  }
  return undefined;
}

/**
 * Does `childType`'s `property` name its parent when `parentType` is that
 * parent's type, for a child that is re-created with it (`recreate` mode)?
 * The diff marks such a property of a replaced resource's reader as a
 * replacement, so the child's own readers are promoted too.
 */
export function namesRecreatedParent(
  childType: string,
  property: string,
  parentType: string | undefined
): boolean {
  if (parentType === undefined || !Object.hasOwn(CHILD_STORED_IN_PARENT, childType)) return false;
  const entry = CHILD_STORED_IN_PARENT[childType]!;
  return (
    entry.mode === undefined &&
    entry.properties.includes(property) &&
    typesFor(entry, property).includes(parentType)
  );
}

/**
 * What a failed deploy does to the record of a child it never restored;
 * `parent` is the logical id of the re-created parent it went with.
 */
export type LostChildAction =
  /** Gone from AWS: drop the record, so the next deploy creates it. */
  | { logicalId: string; parent: string; action: 'forget' }
  /**
   * A policy naming several parents that still holds on the surviving ones,
   * or a resource merely attached to the parents (`reattach`, never gone):
   * keep the record with `trimmed` -- each list minus the recreated parents'
   * entries, or the list a `clears` parent's re-create emptied -- so the next
   * deploy diffs a change and writes or attaches it to them again (and a
   * destroy still removes the surviving copies).
   */
  | { logicalId: string; parent: string; action: 'trim'; trimmed: Record<string, unknown[]> };

/**
 * go-to-k/cdkd#4443: what a FAILED deploy must do to the records of children
 * stored inside a parent it destroyed and re-created under the same physical
 * id, which it never wrote (`written`: every logical id this deploy created,
 * updated or restored -- a child it created or moved onto the recreated parent
 * before failing is live and keeps its record). Each such child is gone from
 * AWS, yet its record survived the failure (the rollback keeps the equal-id
 * parent as done), and every later deploy diffed it `NO_CHANGE`, so it stayed
 * missing for good -- for a bucket or IAM policy carrying a Deny, a control
 * silently absent while state recorded it.
 *
 * A child counts only while its RECORDED parent-naming value names the
 * parent's physical id: one the same deploy was moving onto the recreated
 * parent from another still has its record, and its copy, on the other one.
 * A `reput` child (a policy naming several parents) is forgotten only when
 * every parent it names was recreated; otherwise it is trimmed.
 */
export function lostChildActions(input: {
  templateResources: Readonly<
    Record<string, { Type: string; Properties?: Record<string, unknown> }>
  >;
  records: Readonly<
    Record<
      string,
      { resourceType: string; physicalId: string; properties?: Record<string, unknown> }
    >
  >;
  recreatedUnderSameId: ReadonlySet<string>;
  written: ReadonlySet<string>;
  conditions?: Readonly<Record<string, boolean>> | undefined;
}): LostChildAction[] {
  if (input.recreatedUnderSameId.size === 0) return [];
  const recordOf = (id: string) =>
    Object.hasOwn(input.records, id) ? input.records[id] : undefined;
  // Grandchildren: a forgotten child that is itself a parent type (an alias or
  // version of the recreated function) went with it too, and so did what is
  // stored inside IT (a permission on that alias). Extend the recreated set
  // with each such child and scan again, to a fixpoint.
  const recreated = new Set(input.recreatedUnderSameId);
  const decided = new Map<string, LostChildAction>();
  for (;;) {
    const before = decided.size;
    for (const action of scanLostChildren(input, recreated, recordOf, decided)) {
      decided.set(action.logicalId, action);
      const type = recordOf(action.logicalId)?.resourceType;
      if (action.action === 'forget' && type !== undefined && PARENT_TYPES.has(type)) {
        recreated.add(action.logicalId);
      }
    }
    if (decided.size === before) break;
  }
  return [...decided.values()];
}

/** Every type some child entry names as a parent. */
const PARENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(CHILD_STORED_IN_PARENT).flatMap((entry) => entry.parentTypes)
);

function scanLostChildren(
  input: Parameters<typeof lostChildActions>[0],
  recreated: ReadonlySet<string>,
  recordOf: (
    id: string
  ) =>
    | { resourceType: string; physicalId: string; properties?: Record<string, unknown> }
    | undefined,
  decided: ReadonlyMap<string, LostChildAction>
): LostChildAction[] {
  // The recreated parents' physical ids, by type: a list entry is a re-created
  // holder only when a recreated resource of one of the child's PARENT types
  // carries that id (a recreated function `app` says nothing of a role `app`).
  const recreatedIdsOf = (parentTypes: readonly string[]): string[] =>
    [...recreated]
      .map((id) => recordOf(id))
      .filter((r) => r !== undefined && parentTypes.includes(r.resourceType))
      .map((r) => r!.physicalId)
      .filter((id) => id !== '');
  const actions: LostChildAction[] = [];
  for (const [logicalId, resource] of Object.entries(input.templateResources)) {
    if (decided.has(logicalId) || input.written.has(logicalId) || recreated.has(logicalId)) {
      continue;
    }
    const record = recordOf(logicalId);
    if (record === undefined || record.resourceType !== resource.Type) continue;
    const lost = childLostWithRecreatedParent({
      resourceType: resource.Type,
      templateProperties: resource.Properties,
      recreatedUnderSameId: recreated,
      recordedTypeOf: (id) => recordOf(id)?.resourceType,
      conditions: input.conditions,
    });
    if (lost === undefined) continue;
    const parent = recordOf(lost.parent);
    if (parent === undefined) continue;
    const recorded = record.properties ?? {};
    if (lost.mode !== 'recreate') {
      const trimmed = trimmedHolders(
        CHILD_STORED_IN_PARENT[resource.Type]!,
        recorded,
        recreatedIdsOf
      );
      if (trimmed === undefined) continue;
      actions.push(
        // A `reattach` child still exists, so it is never forgotten.
        lost.mode === 'reattach' ||
          heldElsewhere(CHILD_STORED_IN_PARENT[resource.Type]!, { ...recorded, ...trimmed })
          ? { logicalId, parent: lost.parent, action: 'trim', trimmed }
          : { logicalId, parent: lost.parent, action: 'forget' }
      );
      continue;
    }
    if (!Object.hasOwn(recorded, lost.property)) continue;
    const value = recorded[lost.property];
    if (namesPhysicalId(value, parent.physicalId)) {
      actions.push({ logicalId, parent: lost.parent, action: 'forget' });
    }
  }
  return actions;
}

/**
 * A `reput` / `reattach` child's recorded holder lists with every entry naming
 * a re-created parent of that list's types removed, and each list a `clears`
 * parent's re-create emptied; `undefined` when nothing changes.
 */
function trimmedHolders(
  entry: ChildEntry,
  recorded: Record<string, unknown>,
  recreatedIdsOf: (parentTypes: readonly string[]) => string[]
): Record<string, unknown[]> | undefined {
  const trimmed: Record<string, unknown[]> = {};
  for (const [property, cleared] of Object.entries(entry.clears ?? {})) {
    const value = recorded[property];
    const members = recorded[cleared];
    if (
      typeof value === 'string' &&
      recreatedIdsOf(typesFor(entry, property)).includes(value) &&
      Array.isArray(members) &&
      members.length > 0
    ) {
      trimmed[cleared] = [];
    }
  }
  for (const property of entry.properties) {
    if (Object.hasOwn(trimmed, property) || !Object.hasOwn(recorded, property)) continue;
    const value = recorded[property];
    if (!Array.isArray(value)) continue;
    const ids = recreatedIdsOf(typesFor(entry, property));
    const kept = value.filter((item) => !ids.some((id) => namesPhysicalId(item, id)));
    if (kept.length !== value.length) trimmed[property] = kept;
  }
  return Object.keys(trimmed).length > 0 ? trimmed : undefined;
}

/** Does a `reput` child still name any holder once trimmed? */
function heldElsewhere(entry: ChildEntry, recorded: Record<string, unknown>): boolean {
  return entry.properties.some((key) => {
    const value = recorded[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
  });
}

/**
 * Does a recorded value name `physicalId`: the id itself, or a Lambda
 * function ARN for that function -- `arn:<partition>:lambda:<region>:<account>:function:<id>`
 * or the partial `<account>:function:<id>` that `FunctionName` accepts, each
 * optionally qualified (`:<alias or version>`, which went with the function
 * too) -- anywhere in a list? Only these exact forms: a looser suffix would
 * match a different resource sharing the tail (`/aws/lambda/foo` for the log
 * group `foo`, an alias `...:function:other:my-fn`) and forget a live child.
 */
function namesPhysicalId(value: unknown, physicalId: string): boolean {
  if (physicalId === '') return false;
  if (typeof value === 'string') {
    if (value === physicalId) return true;
    const parts = value.split(':');
    if (parts[0] === 'arn' && (parts.length === 7 || parts.length === 8)) {
      return parts[2] === 'lambda' && parts[5] === 'function' && parts[6] === physicalId;
    }
    if (/^\d{12}$/.test(parts[0]!) && (parts.length === 3 || parts.length === 4)) {
      return parts[1] === 'function' && parts[2] === physicalId;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => namesPhysicalId(item, physicalId));
  return false;
}

/**
 * go-to-k/cdkd#4444: the `NO_CHANGE` rows that are children of a parent this
 * deploy re-created under the same physical id. The diff promotes the readers
 * of a replacement it knows of, so these arise from a re-create the diff did
 * NOT foresee -- the update-failure fallback. A `NO_CHANGE` row's template
 * value is its record, so it names the re-created parent exactly as before.
 */
export function noChangeChildrenOfRecreatedParents(input: {
  changes: ReadonlyMap<string, { changeType: string }>;
  skip: ReadonlySet<string>;
  templateResources: Readonly<
    Record<string, { Type: string; Properties?: Record<string, unknown> }>
  >;
  recreatedUnderSameId: ReadonlySet<string>;
  recordedTypeOf: (logicalId: string) => string | undefined;
  conditions?: Readonly<Record<string, boolean>> | undefined;
}): string[] {
  if (input.recreatedUnderSameId.size === 0) return [];
  const found: string[] = [];
  for (const [logicalId, change] of input.changes) {
    if (change.changeType !== 'NO_CHANGE' || input.skip.has(logicalId)) continue;
    if (!Object.hasOwn(input.templateResources, logicalId)) continue;
    const resource = input.templateResources[logicalId]!;
    if (input.recordedTypeOf(logicalId) !== resource.Type) continue;
    const lost = childLostWithRecreatedParent({
      resourceType: resource.Type,
      templateProperties: resource.Properties,
      recreatedUnderSameId: input.recreatedUnderSameId,
      recordedTypeOf: input.recordedTypeOf,
      conditions: input.conditions,
    });
    if (lost !== undefined) found.push(logicalId);
  }
  return found;
}

/**
 * go-to-k/cdkd#4461: the recorded side a `reattach` child's in-place update
 * diffs against, with every entry naming a re-created parent dropped (or, for
 * a `clears` property naming the parent itself, the list it emptied), so the
 * provider's own add-what-is-new diff attaches it again. `undefined` when
 * nothing names such a parent. In memory only: the record is never rewritten.
 *
 * A dropped name is matched against the re-created parent's physical id (an
 * IAM role, user or group's NAME, which is what these lists hold).
 */
export function withRecreatedAttachmentsDropped(input: {
  resourceType: string;
  templateProperties: Record<string, unknown> | undefined;
  previous: Record<string, unknown>;
  recreatedUnderSameId: ReadonlySet<string>;
  recordOf: (logicalId: string) => { resourceType: string; physicalId: string } | undefined;
  conditions?: Readonly<Record<string, boolean>> | undefined;
}): { previous: Record<string, unknown>; parents: string[] } | undefined {
  if (input.recreatedUnderSameId.size === 0) return undefined;
  if (!Object.hasOwn(CHILD_STORED_IN_PARENT, input.resourceType)) return undefined;
  const entry = CHILD_STORED_IN_PARENT[input.resourceType]!;
  if (entry.mode !== 'reattach') return undefined;
  const properties = input.templateProperties ?? {};
  const out: Record<string, unknown> = { ...input.previous };
  const parents: string[] = [];
  for (const property of entry.properties) {
    if (!Object.hasOwn(properties, property)) continue;
    const value =
      input.conditions === undefined
        ? properties[property]
        : takenFnIfArms(properties[property], input.conditions);
    parser ??= new TemplateParser();
    const recreated = [...parser.extractReferences(value)]
      .filter((id) => input.recreatedUnderSameId.has(id))
      .map((id) => ({ id, record: input.recordOf(id) }))
      .filter(
        (p): p is { id: string; record: { resourceType: string; physicalId: string } } =>
          p.record !== undefined && typesFor(entry, property).includes(p.record.resourceType)
      );
    if (recreated.length === 0) continue;
    const cleared =
      entry.clears !== undefined && Object.hasOwn(entry.clears, property)
        ? entry.clears[property]!
        : undefined;
    if (cleared !== undefined) {
      // Only while the RECORD names the re-created parent too: one the same
      // deploy re-points onto it from another still has its members in the
      // other, and the provider's move removes exactly the recorded ones.
      const names = new Set(recreated.map((p) => p.record.physicalId));
      const recordedParent = out[property];
      if (typeof recordedParent !== 'string' || !names.has(recordedParent)) continue;
      const members = out[cleared];
      if (!Array.isArray(members) || members.length === 0) continue;
      out[cleared] = [];
    } else {
      const recorded = out[property];
      if (!Array.isArray(recorded)) continue;
      const names = new Set(recreated.map((p) => p.record.physicalId));
      const kept = recorded.filter((name) => !(typeof name === 'string' && names.has(name)));
      if (kept.length === recorded.length) continue;
      out[property] = kept;
    }
    for (const { id } of recreated) if (!parents.includes(id)) parents.push(id);
  }
  return parents.length > 0 ? { previous: out, parents } : undefined;
}
