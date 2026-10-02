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
 * Only the replacement arm records a parent. The update-failure fallback
 * (`ResourceUpdateNotSupportedError` -> delete, create) also re-creates under
 * the same id, but the diff never promoted that parent's readers, so they are
 * not reached here (go-to-k/cdkd#4444); nor is a child the deploy failed
 * before reaching, as this set lives only in memory (go-to-k/cdkd#4443).
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
 * - IAM `RolePolicy`, and `Policy` through its `Roles`: inline role
 *   policies, which `DeleteRole` requires removing first (IAM API reference),
 *   so cdkd's role provider deletes them before the role. Its `Users` /
 *   `Groups` are not listed: only the role path was checked.
 *
 * Deliberately NOT listed:
 * - Lambda `EventSourceMapping`: `DeleteFunction` does not delete it (Lambda
 *   API reference: "use DeleteEventSourceMapping").
 * - Lambda `Url`: deleted ASYNCHRONOUSLY with the function, and the Lambda
 *   guide warns that a function re-created at once under the same name may
 *   inherit the old URL instead, so a re-create can collide.
 * - IAM `ManagedPolicy` attachments (`Roles` / `Users` / `Groups`) and an
 *   `InstanceProfile`'s `Roles` (cdkd's role delete removes the role from its
 *   instance profiles): the attachment is lost but the policy or profile
 *   survives, so the remedy is a re-attach, not a re-create (which would
 *   collide on its name).
 */
interface ChildEntry {
  readonly properties: readonly string[];
  readonly parentTypes: readonly string[];
  /** Names several parents, so it is updated in place rather than re-created. */
  readonly mode?: 'reput';
}

const LAMBDA_FUNCTION = 'AWS::Lambda::Function';

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
  'AWS::IAM::Policy': { properties: ['Roles'], parentTypes: ['AWS::IAM::Role'], mode: 'reput' },
};

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
 * `recreate` (created anew, the old one never deleted) or `reput` (updated in
 * place, writing to every parent it names). `undefined` when it is no such
 * child.
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
}): { parent: string; property: string; mode: 'recreate' | 'reput' } | undefined {
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
      if (parentType !== undefined && entry.parentTypes.includes(parentType)) {
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
    entry.parentTypes.includes(parentType)
  );
}
