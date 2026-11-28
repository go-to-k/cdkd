/**
 * `cdkd drift`: per-type uncompared keys and the declared-property helpers.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { hasOwnKey } from '../../../utils/own-keys.js';
import { holdsPrincipalForm } from '../../../analyzer/drift-principal-normalize.js';
import type { ResourceState } from '../../../types/state.js';
import { coerceCfnBoolean } from '../../../provisioning/config-shape.js';
import {
  readStreamPolicy,
  streamPolicyMatchesDeclared,
} from '../../../provisioning/dynamodb-stream-members.js';
import {
  declaredMemberDocument,
  declaredPolicyDocument,
  efsPolicyMatchesDeclared,
  LAMBDA_PERMISSION_STATEMENT_KEYS,
  lambdaPermissionMatchesDeclared,
  policyDocumentMatchesDeclared,
} from '../../../provisioning/settle-after-own-write.js';
import {
  declaredLifecycle,
  lifecycleMatchesDeclared,
  lifecycleReadIsAbsent,
} from '../../../provisioning/providers/s3-bucket/lifecycle-baseline.js';
import {
  declaredInlinePolicies,
  declaredStringList,
  inlinePoliciesAreDeclared,
  stringListIsDeclared,
} from '../../../provisioning/settle-own-write-members.js';
import { sgRulesAreDeclared } from '../../../provisioning/sg-own-write-rules.js';
import {
  getSettledWriteOnlyPropertyPaths,
  tryGetTopLevelWriteOnlyProperties,
} from '../../../provisioning/write-only-properties.js';
import { readHadAgreeingCopies } from '../../../provisioning/providers/iam-policy/agreeing-copies.js';
import {
  declaredTagsReadback,
  tagsMatchDeclared,
} from '../../../provisioning/tags-own-write-baseline.js';
import {
  efsBackupPolicyIsDeclared,
  instanceMetadataOptionsIsDeclared,
  instanceMonitoringIsDeclared,
  instanceProfileIsDeclared,
} from './transitional-read-heals.js';

/**
 * Per resource type, the top-level keys drift never compares unless the
 * template declares them on the resource (go-to-k/cdkd#5736, #5741).
 *
 * `AWS::S3::Bucket` `NotificationConfiguration`: CDK's
 * `bucket.addEventNotification(...)` (and `eventBridgeEnabled`) does not declare
 * it on the bucket. A `Custom::S3BucketNotifications` resource calls
 * `PutBucketNotificationConfiguration` after the bucket settles, and that
 * custom resource can live in ANOTHER stack (`Bucket.fromBucketName(...)
 * .addEventNotification(...)`, `Managed: false`), in a stack cdkd does not
 * manage, or be any other tool. The bucket's observed baseline is captured
 * before any of them runs and still holds a non-empty value
 * (`readNotification` always emits `EventBridgeConfiguration`), so
 * {@link undeclaredEmptyObservedKeys} does not skip it.
 *
 * `AWS::Events::EventBus` `Policy` (go-to-k/cdkd#6323): an
 * `AWS::Events::EventBusPolicy` (CDK's `bus.addToResourcePolicy(...)`, or any
 * `PutPermission` caller) writes the bus's resource policy, and
 * `DescribeEventBus` returns it. The bus's baseline is empty on create, but a
 * later update of the bus re-captures whatever policy the sibling wrote; the
 * sibling's next statement change then reads as drift, and `--revert` wrote the
 * stale document back, undoing the sibling's change (a removed `Condition`
 * widened access).
 *
 * `AWS::IAM::ManagedPolicy` `Roles` / `Users` / `Groups` (go-to-k/cdkd#6328):
 * a principal's `ManagedPolicyArns` writes them. The baseline read races that
 * sibling's write, so it can record the sibling's member; when the sibling
 * later stops writing it (its list shrinks), drift reported the stale member
 * and `--revert` RE-GRANTED it against the template. A DECLARED list is still
 * compared, and the sibling's members are then stripped on both sides
 * (`stripSiblingOwnedMembers`). An IAM role / user / group's undeclared
 * `ManagedPolicyArns`, `Policies`, `PermissionsBoundary` and `Groups` are not
 * here: they are compared on both baselines (go-to-k/cdkd#6627,
 * `src/analyzer/drift-undeclared-grants.ts`).
 *
 * `AWS::EC2::Instance` `BlockDeviceMappings` (go-to-k/cdkd#6384): an
 * `AWS::EC2::VolumeAttachment` attaches its volume after the instance settles,
 * and `DescribeInstances` lists it beside the launch-time devices. The baseline
 * holds the root volume, so it is not empty, and every later drift run read
 * the attachment's device as drift that `--revert` could not undo. A DECLARED
 * list is still compared, over its declared devices only (the EC2 provider's
 * readback).
 */
const UNDECLARED_UNCOMPARED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::S3::Bucket': ['NotificationConfiguration'],
  'AWS::Events::EventBus': ['Policy'],
  'AWS::IAM::ManagedPolicy': ['Groups', 'Roles', 'Users'],
  'AWS::EC2::Instance': ['BlockDeviceMappings'],
};

/**
 * Per resource type, the undeclared top-level keys drift DOES compare even when
 * the observed baseline captured them empty (`{}`, `[]`, `null`) — the reverse
 * of {@link UNDECLARED_UNCOMPARED_KEYS} (go-to-k/cdkd#6651).
 *
 * `undeclaredEmptyObservedKeys` skips every undeclared captured-empty key
 * (go-to-k/cdkd#1498), because a sibling resource or AWS fills many of them
 * after the baseline is read (ECS `CapacityProviders`, an ASG's lifecycle
 * hooks); comparing those reported drift forever and `--revert` stripped the
 * sibling's configuration. The skip also hid an out-of-band add to a key
 * nothing else writes. A key listed here is compared, so that add is reported
 * and `--revert` sends the empty baseline back.
 *
 * A key joins only by measurement, never by default: no other resource type
 * and no AWS-side process may write it, and a revert from the empty baseline
 * must be measured to clear it on AWS. A wrong entry brings back the #1498
 * phantom drift and a revert that deletes another writer's configuration.
 *
 * `AWS::BedrockAgentCore::Runtime`: only the runtime's own
 * `CreateAgentRuntime` / `UpdateAgentRuntime` write these four, and
 * `UpdateAgentRuntime` is full-replace, so the provider omitting an empty one
 * clears it (measured us-east-1, PR #6630 and #6651).
 * `CapacityProviderConfiguration` is not listed: it is unmeasured.
 *
 * `AWS::IAM::User` `LoginProfile` (go-to-k/cdkd#6755): the user readback
 * records `null` for a user without a login profile whose template declares
 * none. Only `CreateLoginProfile` makes one: no other resource type writes it
 * and IAM never adds one itself. A console login added out of band is drift,
 * and `--revert` sends `null`, which the provider's `update()` turns into one
 * `DeleteLoginProfile` (the `iam-access-key` integ's login-profile arm
 * measures it).
 *
 * `AWS::CodeCommit::Repository` `Triggers` (go-to-k/cdkd#6854): only
 * `PutRepositoryTriggers` writes them, no CloudFormation type other than the
 * repository does, and a repository is created with none (`[]`). A trigger
 * added out of band is drift, and `--revert` sends `[]`, which the provider
 * puts as the whole set: measured us-east-1, `PutRepositoryTriggers` with
 * `[]` leaves `GetRepositoryTriggers` answering `[]`.
 */
const UNDECLARED_EMPTY_COMPARED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'AWS::BedrockAgentCore::Runtime': [
    'FilesystemConfigurations',
    'HooksConfiguration',
    'RequestHeaderConfiguration',
    'ResourceConfigurations',
  ],
  'AWS::CodeCommit::Repository': ['Triggers'],
  'AWS::IAM::User': ['LoginProfile'],
};

/**
 * The undeclared top-level keys of `resourceType` drift compares even when the
 * observed baseline captured them empty ({@link UNDECLARED_EMPTY_COMPARED_KEYS},
 * go-to-k/cdkd#6651). Fed to `undeclaredEmptyObservedKeys`.
 */
export function undeclaredEmptyComparedDriftKeys(resourceType: string): readonly string[] {
  return hasOwnKey(UNDECLARED_EMPTY_COMPARED_KEYS, resourceType)
    ? UNDECLARED_EMPTY_COMPARED_KEYS[resourceType]!
    : [];
}

/**
 * The top-level keys drift must NOT compare on one resource: its type's
 * {@link UNDECLARED_UNCOMPARED_KEYS} entries that its state `properties` (the
 * template) does not declare (go-to-k/cdkd#5741).
 *
 * WHY: comparing them reported another writer's configuration as drift, and
 * `drift --revert` wrote the baseline back and DELETED that writer's live
 * configuration. Scanning the state for the writing custom resource (#5736's
 * first rule, same stack only) cannot see every writer — another stack's state,
 * a CloudFormation-deployed stack, a non-CDK tool — and each one it misses is a
 * deletion path. CloudFormation drift compares only the properties the
 * template declares, so it reports nothing here either. A key the template DOES
 * declare is still compared, as it would be in CloudFormation.
 *
 * The rule reads only state, so a stack deployed with the old baseline is fixed
 * without a redeploy, and `--revert` / `--accept` never act on the key: both
 * work from the detected changes. It applies to an SDK-provisioned and a Cloud
 * Control-provisioned record alike. A record whose `properties` is not a plain
 * object gets no skip.
 */
export function undeclaredUncomparedDriftKeys(resourceType: string, properties: unknown): string[] {
  const keys = hasOwnKey(UNDECLARED_UNCOMPARED_KEYS, resourceType)
    ? UNDECLARED_UNCOMPARED_KEYS[resourceType]!
    : [];
  if (keys.length === 0) return [];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return [];
  }
  return keys.filter((key) => !hasOwnKey(properties as Record<string, unknown>, key));
}

/**
 * The top-level keys drift must NOT compare on one resource because its
 * observed baseline holds a value an earlier cdkd recorded by mistake
 * (go-to-k/cdkd#5749). Today one rule: an `AWS::Lambda::EventSourceMapping`
 * whose baseline holds `Enabled: false` while the template does not declare
 * `Enabled: false` and the live mapping reads `Enabled: true`.
 *
 * WHY: before #5737 the post-create baseline was read while the mapping was
 * still `Creating` and recorded `Enabled: false` for every mapping the
 * template leaves enabled. A no-change deploy never re-reads it, so on such a
 * stack `cdkd drift` reported `Enabled: false -> true` and `--revert` sent
 * `Enabled: false`, stopping the consumer. CloudFormation compares the live
 * value with the template (absent means `true`), so it reports nothing here.
 *
 * Read with {@link coerceCfnBoolean}, the reading the provider's
 * `enabledFromState` gives the template value. A template declaring
 * `Enabled: false` keeps the normal comparison, as does a live mapping that
 * reads disabled, so a disable cdkd did not make is still reported against a
 * `true` baseline. What the rule cannot tell apart: a disable that was
 * accepted into the baseline and then re-enabled outside cdkd. Re-enabling
 * against the template's own default is not reported, which is what
 * CloudFormation would say too. A live `true` also comes from a mapping still
 * `Creating` / `Updating` under such a template (`enabledFromState` answers
 * the template's value there); skipping the key then is no loss, since the
 * comparison would have reported the same stale `false -> true`.
 *
 * Read-only and per resource: nothing is written to state. `--revert` and
 * `--accept` act only on detected changes, so neither touches the key. The
 * baseline is rewritten by the next update deploy of the mapping or by
 * `cdkd state refresh-observed`. Only the observed baseline can carry the
 * artifact; the `properties` fallback is the template itself.
 *
 * Second rule (go-to-k/cdkd#6604): an `AWS::DynamoDB::Table` `ResourcePolicy`
 * that the baseline and the live table disagree on while the live table
 * agrees with the TEMPLATE — a recorded policy the template no longer
 * declares and the table no longer holds, or a missing or other recorded
 * policy while the table holds exactly the declared one. Before #6604 the baseline was read
 * right after the put / delete, and `GetResourcePolicy` lags (a deleted
 * policy is still served for seconds), so `drift --revert` re-granted a
 * removed policy, or deleted a declared one. What the rule cannot tell apart
 * is an out-of-band change that put the table back to the template, which
 * CloudFormation would not report either.
 *
 * Third rule (go-to-k/cdkd#6609): an `AWS::SQS::QueuePolicy` /
 * `AWS::SNS::TopicPolicy` `PolicyDocument`, or the statement keys of an
 * `AWS::Lambda::Permission`, recorded as something other than the declared
 * value while the live resource holds exactly the declared value. Before
 * #6609 the baseline took the first answer right after the write, which can
 * still be the policy the write replaced, so `drift --revert` re-granted it.
 * Same blind spot as the second rule, and the rule cannot tell a stale
 * baseline from one `drift --accept` wrote: an accepted out-of-band change
 * that is later undone outside cdkd, putting the resource back to the
 * template, is not reported. CloudFormation, which compares with the
 * template, would not report it either.
 *
 * Fourth rule (go-to-k/cdkd#6609, second slice): a member a separate call
 * writes onto a bigger resource — `AWS::KMS::Key` `KeyPolicy`,
 * `AWS::Logs::DeliveryDestination` `DeliveryDestinationPolicy`,
 * `AWS::Logs::LogGroup` `DataProtectionPolicy`, `AWS::ApiGateway::RestApi`
 * `Policy`, `AWS::EFS::FileSystem` `FileSystemPolicy`,
 * `AWS::CodeBuild::Project` `Visibility`, `AWS::S3::Bucket`
 * `LifecycleConfiguration` (third slice) — is not compared while the live
 * member is the declared one (IAM-equivalent spellings folded), whatever the
 * baseline holds: a value captured before the write showed, or a kept
 * declared value AWS spells differently (a lifecycle rule declared without
 * an `Id`, kept without the `Id` S3 generates, compares with the provider's
 * own settle comparator, `lifecycleMatchesDeclared`). Where removing the member deletes
 * it, a template declaring none and a resource holding none agree too. The
 * `--accept` blind spot is the third rule's: an accepted out-of-band change
 * later undone outside cdkd, putting the member back to the template, is not
 * reported, which CloudFormation would not report either.
 *
 * Fourth slice: the `AWS::IAM::Role` / `User` / `Group` / `ManagedPolicy` /
 * `InstanceProfile` members, `AWS::S3::BucketPolicy` `PolicyDocument`,
 * `AWS::Events::EventBus` `Policy` and `AWS::EC2::SecurityGroup` rules, with
 * the same `--accept` blind spot. A list is skipped only while the live list
 * is EXACTLY the declared one as a set (names / ARNs / policy names with
 * their documents, `sgSettleRuleKey` for rules): a superset or a subset is an
 * out-of-band attach or detach and stays compared. A rule declared by
 * `SourceSecurityGroupName` alone keeps its list compared. A live list
 * holding an entry the read does not strip (a managed policy's attacher role
 * declared by a sibling role's `ManagedPolicyArns`, a user's group from an
 * `AWS::IAM::UserToGroupAddition`, a bus statement from an
 * `AWS::Events::EventBusPolicy`) never heals: it is compared as before.
 *
 * `AWS::IAM::Policy` (slice C2), same blind spot: `PolicyDocument` is skipped
 * only while EVERY principal's copy is the declared document — a read whose
 * copies differ surfaces one of them (go-to-k/cdkd#6616), so it heals only on a
 * bag the read marked as every copy agreeing (`readHadAgreeingCopies`): a bag
 * that lost the mark stays compared. `PolicyName` heals on the
 * exact declared name; `Roles` / `Users` / `Groups` on the exact declared set
 * (the read echoes the recorded list less a principal lacking the policy, so a
 * detached principal is a subset and stays compared). A principal that gained
 * the policy out of band is invisible to the read anyway (#6616).
 *
 * Slice E: `AWS::DynamoDB::Table` and `AWS::SecretsManager::Secret` `Tags`,
 * with the same `--accept` blind spot, skipped only while the live tags
 * (`aws:` dropped) are EXACTLY the declared set, key and value: a tag outside
 * the template or a missing declared tag stays compared. An
 * `AWS::DynamoDB::GlobalTable` replica's tags live inside `Replicas`, which
 * this rule (top-level keys only) cannot skip without hiding the replica's
 * other members, so a pre-fix replica `Tags` baseline is still compared until
 * the next update or `cdkd state refresh-observed` rewrites it.
 *
 * `AWS::AppSync::GraphQLSchema` `Definition` (go-to-k/cdkd#7127), same blind
 * spot: before #7127 the baseline was read while AppSync still served the
 * schema the deploy replaced, so `drift --revert` pushed the old schema back.
 * Skipped only while the live SDL is the declared inline `Definition`. A
 * schema sourced from `DefinitionS3Location` declares no SDL here, so the
 * AppSync provider's `canonicalizeDriftPair` reads the declared object and
 * heals that baseline instead (go-to-k/cdkd#7139): an S3 read this
 * synchronous, call-free rule cannot make.
 *
 * Fifth rule (go-to-k/cdkd#7132): a member whose post-update baseline was read
 * while AWS still answered a transitional value — `AWS::EC2::Instance`
 * `Monitoring` (right after `MonitorInstances` the read said `disabled`, after
 * `UnmonitorInstances` `enabled`), `IamInstanceProfile` (the association still
 * `associating`, so the old profile or none), `MetadataOptions` (State
 * `pending`, old values), and `AWS::EFS::FileSystem` `BackupPolicy` (`Status`
 * `ENABLING` / `DISABLING`, which `--revert` would send and AWS refuses). A
 * no-change deploy never re-reads, so stacks deployed before #7132 keep that
 * baseline. The key is not compared while the live member is the DECLARED one
 * as the provider's read spells it: `Monitoring` through `coerceCfnBoolean`;
 * `IamInstanceProfile` on an exact match or on a declared plain name equal to
 * the last segment of the live `:instance-profile/` ARN (a path-qualified
 * declared name keeps it compared); `MetadataOptions` on every declared member
 * (scalars compared as text) AND every undeclared member reading as the
 * baseline recorded it, so an out-of-band hop-limit change stays reported;
 * `BackupPolicy` on the declared `Status`. A member the template leaves out
 * never heals, and a live member that differs from the template is compared
 * as before. As in the fourth rule the baseline is not consulted (a baseline
 * equal to the template reports nothing either way). What the rule cannot
 * tell apart: a baseline `drift --accept` wrote for an out-of-band change that
 * was later undone outside cdkd, putting the member back to the template —
 * not reported, which CloudFormation, comparing with the template, would not
 * report either.
 */
export function preFixBaselineUncomparedDriftKeys(
  resourceType: string,
  observed: Record<string, unknown> | undefined,
  properties: unknown,
  aws: Record<string, unknown>
): string[] {
  if (observed === undefined) return [];
  // go-to-k/cdkd#6680: no rule skips a key whose recorded value holds an IAM
  // unique-id principal (`AROA…` / `AIDA…`, the form AWS renders for a
  // principal it could not resolve) while the live value holds an IAM ARN
  // principal: the pair the issue #1515 canonicalization decides, so the key
  // stays compared and a unique id that is not the live principal's is drift.
  // A live value with no IAM ARN gives #1515 nothing to prove, so the heal
  // stands. Wrapped under its key, so a top-level `Principal` (a Lambda
  // permission) counts.
  return preFixBaselineKeys(resourceType, observed, properties, aws).filter(
    (key) =>
      !(
        holdsPrincipalForm({ [key]: observed[key] }, 'uniqueIds') &&
        holdsPrincipalForm({ [key]: aws[key] }, 'arns')
      )
  );
}

function preFixBaselineKeys(
  resourceType: string,
  observed: Record<string, unknown>,
  properties: unknown,
  aws: Record<string, unknown>
): string[] {
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return [];
  }
  if (resourceType === 'AWS::DynamoDB::Table') {
    const bag = properties as Record<string, unknown>;
    return [
      ...(staleTablePolicyBaseline(observed, bag, aws) ? ['ResourcePolicy'] : []),
      ...(tagsHeal.liveIsDeclared(bag, aws, observed) ? [tagsHeal.key] : []),
    ];
  }
  if (resourceType === 'AWS::SQS::QueuePolicy' || resourceType === 'AWS::SNS::TopicPolicy') {
    const declared = declaredPolicyDocument(properties);
    return declared !== undefined &&
      policyDocumentMatchesDeclared(aws['PolicyDocument'], declared) &&
      !policyDocumentMatchesDeclared(observed['PolicyDocument'], declared)
      ? ['PolicyDocument']
      : [];
  }
  if (resourceType === 'AWS::Lambda::Permission') {
    const declared = properties as Record<string, unknown>;
    return lambdaPermissionMatchesDeclared(aws, declared) &&
      !lambdaPermissionMatchesDeclared(observed, declared)
      ? [...LAMBDA_PERMISSION_STATEMENT_KEYS]
      : [];
  }
  const members = OWN_WRITE_MEMBERS.get(resourceType);
  if (members !== undefined) {
    return members
      .filter((member) =>
        member.liveIsDeclared(properties as Record<string, unknown>, aws, observed)
      )
      .map((member) => member.key);
  }
  if (resourceType !== 'AWS::Lambda::EventSourceMapping') return [];
  const declared = hasOwnKey(properties as Record<string, unknown>, 'Enabled')
    ? coerceCfnBoolean((properties as Record<string, unknown>)['Enabled'])
    : undefined;
  const recorded = hasOwnKey(observed, 'Enabled')
    ? coerceCfnBoolean(observed['Enabled'])
    : undefined;
  const live = hasOwnKey(aws, 'Enabled') ? aws['Enabled'] : undefined;
  return recorded === false && declared !== false && live === true ? ['Enabled'] : [];
}

/**
 * The fourth rule of {@link preFixBaselineUncomparedDriftKeys}: per type, each
 * member key and whether the live member is the declared one. Where removing
 * the member deletes it, "none declared and none live" agrees too.
 */
type OwnWriteHeal = {
  key: string;
  liveIsDeclared: (
    properties: Record<string, unknown>,
    aws: Record<string, unknown>,
    observed: Record<string, unknown>
  ) => boolean;
};

/** A declared document member, matched as the settle matches it. */
const documentHeal = (key: string): OwnWriteHeal => ({
  key,
  liveIsDeclared: (properties, aws) => {
    const declared = declaredMemberDocument(properties[key]);
    return declared !== undefined && policyDocumentMatchesDeclared(aws[key], declared);
  },
});

/** A declared string list (names, ARNs): exactly the declared set live. */
const stringListHeal = (key: string): OwnWriteHeal => ({
  key,
  liveIsDeclared: (properties, aws) => {
    const declared = declaredStringList(properties[key]);
    return declared !== undefined && stringListIsDeclared(aws[key], declared);
  },
});

const boundaryHeal: OwnWriteHeal = {
  key: 'PermissionsBoundary',
  liveIsDeclared: (properties, aws) =>
    typeof properties['PermissionsBoundary'] === 'string' &&
    properties['PermissionsBoundary'] !== '' &&
    aws['PermissionsBoundary'] === properties['PermissionsBoundary'],
};

const inlinePoliciesHeal: OwnWriteHeal = {
  key: 'Policies',
  liveIsDeclared: (properties, aws) => {
    const declared = declaredInlinePolicies(properties['Policies']);
    return declared !== undefined && inlinePoliciesAreDeclared(aws['Policies'], declared);
  },
};

const sgRulesHeal = (key: string, direction: 'ingress' | 'egress'): OwnWriteHeal => ({
  key,
  liveIsDeclared: (properties, aws) => sgRulesAreDeclared(aws[key], properties[key], direction),
});

/**
 * `Tags` (slice E): skipped only while the live tags (`aws:` dropped, as the
 * read drops them) are EXACTLY the declared set, key and value. A tag outside
 * the template, or a declared tag missing, stays compared.
 */
const tagsHeal: OwnWriteHeal = {
  key: 'Tags',
  liveIsDeclared: (properties, aws) => {
    const declared = declaredTagsReadback(properties['Tags']);
    return declared !== undefined && tagsMatchDeclared(aws['Tags'], declared);
  },
};

const OWN_WRITE_MEMBERS: ReadonlyMap<string, readonly OwnWriteHeal[]> = new Map(
  Object.entries({
    'AWS::KMS::Key': [documentHeal('KeyPolicy')],
    'AWS::Logs::DeliveryDestination': [
      {
        key: 'DeliveryDestinationPolicy',
        liveIsDeclared: (properties, aws) => {
          // An object only, as the provider settles it (CloudFormation refuses a string).
          const inner = (block: unknown): unknown => {
            const document =
              typeof block === 'object' && block !== null && !Array.isArray(block)
                ? (block as Record<string, unknown>)['DeliveryDestinationPolicy']
                : undefined;
            return typeof document === 'object' && document !== null && !Array.isArray(document)
              ? document
              : undefined;
          };
          const declared = inner(properties['DeliveryDestinationPolicy']);
          if (declared === undefined) {
            return (
              properties['DeliveryDestinationPolicy'] === undefined &&
              aws['DeliveryDestinationPolicy'] === undefined
            );
          }
          return policyDocumentMatchesDeclared(inner(aws['DeliveryDestinationPolicy']), declared);
        },
      },
    ],
    'AWS::Logs::LogGroup': [
      {
        key: 'DataProtectionPolicy',
        liveIsDeclared: (properties, aws) => {
          const declared = declaredMemberDocument(properties['DataProtectionPolicy']);
          if (declared === undefined) {
            return (
              (properties['DataProtectionPolicy'] === undefined ||
                properties['DataProtectionPolicy'] === '') &&
              aws['DataProtectionPolicy'] === ''
            );
          }
          return policyDocumentMatchesDeclared(aws['DataProtectionPolicy'], declared);
        },
      },
    ],
    // A removed RestApi `Policy` is left at its live value, so only a declared one settles.
    'AWS::ApiGateway::RestApi': [documentHeal('Policy')],
    'AWS::EFS::FileSystem': [
      {
        key: 'FileSystemPolicy',
        liveIsDeclared: (properties, aws) => {
          const declared = declaredMemberDocument(properties['FileSystemPolicy']);
          if (declared === undefined) {
            return (
              properties['FileSystemPolicy'] === undefined && aws['FileSystemPolicy'] === undefined
            );
          }
          return efsPolicyMatchesDeclared(aws['FileSystemPolicy'], declared);
        },
      },
      // Fifth rule (go-to-k/cdkd#7132): a baseline read as `ENABLING` / `DISABLING`.
      { key: 'BackupPolicy', liveIsDeclared: efsBackupPolicyIsDeclared },
    ],
    // Fifth rule (go-to-k/cdkd#7132): baselines read while the update was still settling.
    'AWS::EC2::Instance': [
      { key: 'Monitoring', liveIsDeclared: instanceMonitoringIsDeclared },
      { key: 'IamInstanceProfile', liveIsDeclared: instanceProfileIsDeclared },
      { key: 'MetadataOptions', liveIsDeclared: instanceMetadataOptionsIsDeclared },
    ],
    'AWS::S3::Bucket': [
      {
        // The comparator the post-write capture settles on, so the two agree.
        key: 'LifecycleConfiguration',
        liveIsDeclared: (properties, aws) => {
          const declared = declaredLifecycle(properties);
          const live = aws['LifecycleConfiguration'];
          if (declared === undefined || typeof live !== 'object' || live === null) return false;
          const liveBag = live as Record<string, unknown>;
          return declared.kind === 'absent'
            ? lifecycleReadIsAbsent(liveBag)
            : lifecycleMatchesDeclared(liveBag, declared.expected);
        },
      },
    ],
    'AWS::SecretsManager::Secret': [tagsHeal],
    'AWS::CodeBuild::Project': [
      {
        key: 'Visibility',
        liveIsDeclared: (properties, aws) =>
          typeof properties['Visibility'] === 'string' &&
          properties['Visibility'] !== '' &&
          aws['Visibility'] === properties['Visibility'],
      },
    ],
    'AWS::IAM::Role': [
      documentHeal('AssumeRolePolicyDocument'),
      boundaryHeal,
      stringListHeal('ManagedPolicyArns'),
      inlinePoliciesHeal,
    ],
    'AWS::IAM::User': [
      boundaryHeal,
      stringListHeal('ManagedPolicyArns'),
      stringListHeal('Groups'),
      inlinePoliciesHeal,
    ],
    'AWS::IAM::Group': [stringListHeal('ManagedPolicyArns'), inlinePoliciesHeal],
    'AWS::IAM::ManagedPolicy': [
      documentHeal('PolicyDocument'),
      stringListHeal('Roles'),
      stringListHeal('Users'),
      stringListHeal('Groups'),
    ],
    'AWS::IAM::InstanceProfile': [stringListHeal('Roles')],
    // Only a read whose every copy agreed may skip it; an unmarked bag is compared.
    'AWS::IAM::Policy': [
      {
        key: 'PolicyDocument',
        liveIsDeclared: (properties, aws, observed) =>
          readHadAgreeingCopies(aws) &&
          documentHeal('PolicyDocument').liveIsDeclared(properties, aws, observed),
      },
      {
        key: 'PolicyName',
        liveIsDeclared: (properties, aws) =>
          typeof properties['PolicyName'] === 'string' &&
          properties['PolicyName'] !== '' &&
          aws['PolicyName'] === properties['PolicyName'],
      },
      stringListHeal('Roles'),
      stringListHeal('Users'),
      stringListHeal('Groups'),
    ],
    'AWS::S3::BucketPolicy': [
      {
        key: 'PolicyDocument',
        liveIsDeclared: (properties, aws) => {
          const declared = declaredPolicyDocument(properties);
          return (
            declared !== undefined && policyDocumentMatchesDeclared(aws['PolicyDocument'], declared)
          );
        },
      },
    ],
    // The WHOLE document: a sibling EventBusPolicy's statement keeps it compared.
    'AWS::Events::EventBus': [documentHeal('Policy')],
    'AWS::EC2::SecurityGroup': [
      sgRulesHeal('SecurityGroupIngress', 'ingress'),
      sgRulesHeal('SecurityGroupEgress', 'egress'),
    ],
    // go-to-k/cdkd#7127: the read answers the declared bytes exactly when the
    // live SDL canonicalizes to them (`readGraphQLSchema`).
    'AWS::AppSync::GraphQLSchema': [
      {
        key: 'Definition',
        liveIsDeclared: (properties, aws) =>
          typeof properties['Definition'] === 'string' &&
          properties['Definition'] !== '' &&
          aws['Definition'] === properties['Definition'],
      },
    ],
  })
);

/** The #6604 half of {@link preFixBaselineUncomparedDriftKeys}. */
function staleTablePolicyBaseline(
  observed: Record<string, unknown>,
  properties: Record<string, unknown>,
  aws: Record<string, unknown>
): boolean {
  const recorded = readStreamPolicy(observed);
  const declared = readStreamPolicy(properties);
  const live = readStreamPolicy(aws);
  if (recorded.kind === 'usable' && declared.kind === 'absent' && live.kind === 'absent') {
    return true;
  }
  // A recorded document other than the live one, while the live one is the
  // declared one: whatever the baseline holds, `--revert` would push a stale
  // value (a replaced policy captured before the put showed).
  return (
    declared.kind === 'usable' &&
    live.kind === 'usable' &&
    streamPolicyMatchesDeclared(live.document, properties)
  );
}

/**
 * The schema read-only paths drift must NOT compare on one Cloud Control
 * readback (go-to-k/cdkd#6485): every path of `readOnlyPaths`
 * (`getReadOnlyPropertyPaths`) that `properties` (the template) does not
 * declare.
 *
 * WHY: the observed baseline is the whole Cloud Control model, so it records
 * read-only values such as `UpdateTime`, which AWS changes on every update.
 * Comparing them reported an out-of-band edit's timestamp as drift, and
 * `--revert` sent the old timestamp in its patch, which Cloud Control refuses
 * whole, so the real drift was not reverted either. CloudFormation drift
 * compares only what a template declares. A declared path is still compared:
 * a schema that marks a settable property read-only stays visible.
 *
 * Read-only and per resource, like the rules above: a baseline written before
 * this rule is compared around, not rewritten. `undefined` (the schema could
 * not be read) skips nothing, the comparison before the rule.
 */
export function readOnlyUncomparedDriftPaths(
  readOnlyPaths: readonly string[] | undefined,
  properties: unknown
): string[] {
  if (!readOnlyPaths || readOnlyPaths.length === 0) return [];
  const declared = (path: string): boolean => {
    let node: unknown = properties;
    for (const segment of path.split('.')) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
      if (!hasOwnKey(node as Record<string, unknown>, segment)) return false;
      node = (node as Record<string, unknown>)[segment];
    }
    return true;
  };
  return readOnlyPaths.filter((path) => !declared(path));
}

/**
 * The schema write-only paths of `resourceType` as dotted drift paths
 * (`MasterUserPassword`, `Config.Secret`), or `undefined` when the schema
 * could not be read (go-to-k/cdkd#6854). A Cloud Control read never returns
 * a write-only property, so on a record with no observed baseline (the
 * template's `properties` are the baseline) every declared one read as
 * removed. CloudFormation drift does not compare write-only properties
 * either. A path through a list (`*`), or naming a key a dotted path cannot
 * spell, is left out: it stays compared. Never throws.
 */
export function writeOnlyDriftPaths(resourceType: string): Promise<string[] | undefined> {
  let entry = writeOnlyDriftPathsCache.get(resourceType);
  if (entry === undefined) {
    entry = lookUpWriteOnlyDriftPaths(resourceType);
    writeOnlyDriftPathsCache.set(resourceType, entry);
  }
  return entry;
}

/**
 * One lookup per type for the run, an unreadable schema included: a denied
 * `cloudformation:DescribeType` is not retried for every record of the type.
 */
const writeOnlyDriftPathsCache = new Map<string, Promise<string[] | undefined>>();

/** Clear {@link writeOnlyDriftPaths}'s per-type cache. Test-only helper. */
export function clearWriteOnlyDriftPathsCache(): void {
  writeOnlyDriftPathsCache.clear();
}

async function lookUpWriteOnlyDriftPaths(resourceType: string): Promise<string[] | undefined> {
  try {
    // Only says whether the schema was read. Its names are the CONTAINING
    // top-level property of every write-only pointer (`Config` for
    // `/properties/Config/Secret`), and skipping one would hide the
    // writable members beside the write-only one; the paths come from the
    // pointers themselves.
    if ((await tryGetTopLevelWriteOnlyProperties(resourceType)) === undefined) return undefined;
    const paths: string[] = [];
    for (const segments of getSettledWriteOnlyPropertyPaths(resourceType)) {
      if (
        segments.length > 0 &&
        segments.every(
          (segment) =>
            segment !== '' && segment !== '*' && !segment.includes('.') && !segment.endsWith('[]')
        )
      ) {
        paths.push(segments.join('.'));
      }
    }
    return paths;
  } catch {
    return undefined;
  }
}

/**
 * Per resource type, nested members a read echoes beside the member they are
 * derived from, where a WRITE may carry only one of the two
 * (go-to-k/cdkd#6497).
 *
 * `AWS::SecretsManager::RotationSchedule`: a schedule set as
 * `ScheduleExpression: rate(N days)` (CDK's `automaticallyAfter`) reads back
 * with `AutomaticallyAfterDays: N` as well, and Secrets Manager refuses a
 * request carrying both ("You cannot specify both rotation frequency and
 * schedule expression together"). The observed baseline records the read, so
 * `--revert` overlaid the echo beside the expression and the update failed.
 * A schedule set as `AutomaticallyAfterDays` alone reads back without an
 * expression, so the other direction needs no entry.
 */
const DERIVED_ECHO_MEMBERS: Readonly<
  Record<string, readonly { parent: string; source: string; echo: string }[]>
> = {
  'AWS::SecretsManager::RotationSchedule': [
    {
      parent: 'RotationRules',
      source: 'ScheduleExpression',
      echo: 'AutomaticallyAfterDays',
    },
  ],
};

/**
 * `bag` without each {@link DERIVED_ECHO_MEMBERS} echo that sits beside its
 * source member (go-to-k/cdkd#6497). Applied to both comparison sides, and to
 * `--revert`'s desired bag, so the revert's patch removes the live echo and
 * sends the source alone. A side holding the echo WITHOUT the source keeps it:
 * there it is the configured value.
 *
 * Copy-on-write: `bag` is returned by identity when nothing is stripped, and
 * never mutated. A baseline written before this rule needs no heal, since the
 * strip runs on every comparison.
 */
export function stripDerivedEchoMembers(
  resourceType: string,
  bag: Record<string, unknown>
): Record<string, unknown> {
  const rules = DERIVED_ECHO_MEMBERS[resourceType];
  if (!rules) return bag;
  let out = bag;
  for (const { parent, source, echo } of rules) {
    const node = hasOwnKey(out, parent) ? out[parent] : undefined;
    if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
    const members = node as Record<string, unknown>;
    if (!hasOwnKey(members, echo) || !hasOwnKey(members, source)) continue;
    if (members[source] === undefined || members[source] === null) continue;
    const { [echo]: _echo, ...rest } = members;
    out = { ...out, [parent]: rest };
  }
  return out;
}

/**
 * The physical ids of every record of `resources` OTHER than `logicalId`'s
 * (go-to-k/cdkd#4810). Drift resolves state with no resource records, so no
 * `Ref` / `Fn::GetAtt` read records a copy; each of these ids is stored in
 * plaintext in its own record, so a reader's copy of one adds nothing to
 * state. The record's OWN id is left out, as a deploy records none: a
 * resource never reads itself.
 */
export function otherPhysicalIds(
  resources: Record<string, ResourceState> | undefined,
  logicalId: string
): string[] {
  const ids: string[] = [];
  for (const [id, record] of Object.entries(resources ?? {})) {
    if (id !== logicalId && typeof record?.physicalId === 'string') ids.push(record.physicalId);
  }
  return ids;
}

/**
 * The top-level keys `properties` (a record's template side) declares EMPTY:
 * `''`, `[]`, `{}`, or a JSON string of an empty list or object
 * (`UpdateContext.declaredEmptyProperties`, go-to-k/cdkd#4884). A key whose
 * value is anything else, unparsable or a mask included, is not in it.
 */
export function declaredEmptyProperties(properties: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return out;
  }
  const isEmpty = (v: unknown): boolean =>
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof value === 'string') {
      if (value.trim() === '') {
        out.add(key);
        continue;
      }
      try {
        if (isEmpty(JSON.parse(value) as unknown)) out.add(key);
      } catch {
        // Not JSON: a declared value, not an empty one.
      }
    } else if (isEmpty(value)) {
      out.add(key);
    }
  }
  return out;
}

/**
 * The top-level keys `properties` (a record's template side) declares as the
 * boolean `true`: `true` or the string `'true'`
 * (`UpdateContext.declaredTrueProperties`, go-to-k/cdkd#5707). Anything else,
 * `'True'`, a mask, an intrinsic or a nested `true` included, is not in it.
 * On a record with no `observedProperties`, `properties` can also hold a value
 * `cdkd drift --accept` wrote from the readback, which then counts.
 */
export function declaredTrueProperties(properties: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return out;
  }
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    if (value === true || value === 'true') out.add(key);
  }
  return out;
}
