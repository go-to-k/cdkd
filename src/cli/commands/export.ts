import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  ExecuteChangeSetCommand,
  DescribeStacksCommand,
  DescribeTypeCommand,
  DeleteChangeSetCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackImportComplete,
  waitUntilStackUpdateComplete,
  type ResourceToImport,
  type Parameter,
} from '@aws-sdk/client-cloudformation';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import type { ResourceState, StackState } from '../../types/state.js';

interface ExportOptions {
  app?: string;
  output?: string;
  template?: string;
  cfnStackName?: string;
  stateBucket?: string;
  statePrefix: string;
  stackRegion?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  context?: string[];
  /**
   * Allow proceeding when the user passed CLI `-c key=value` overrides
   * that are not persisted to cdk.json / cdk.context.json. The default
   * is to refuse, because those CLI values are visible to cdkd's synth
   * but invisible to subsequent `cdk deploy` invocations — a different
   * template gets synthesized post-migration, which causes spurious
   * drift or replacement on the first `cdk deploy`.
   */
  acceptTransientContext: boolean;
  /**
   * When true and the stack contains resources that cannot be CFn-imported
   * (currently only `Custom::*` qualifies), run a 2-phase migration:
   *   Phase 1: IMPORT changeset for importable resources.
   *   Phase 2: UPDATE changeset for the full template — CFn CREATEs the
   *            non-importable resources fresh, invoking each
   *            `Custom::*`'s backing Lambda's onCreate handler.
   *
   * Default false: the command aborts with a clear error if any
   * non-importable resource is present, so users opt in to the
   * potential side effects (CR onCreate is re-run, which may not be
   * idempotent).
   */
  includeNonImportable: boolean;
  /**
   * `Key=Value` overrides for CFn template Parameters, repeatable. Used
   * when the synthesized template's Parameters section has entries
   * without `Default` values, or when the user wants to override a
   * default for the export.
   */
  parameter?: string[];
  /**
   * Refuse to export when another cdkd stack in the same CDK app
   * references the exporting stack via `Fn::GetStackOutput`. The default
   * is to warn but proceed (the user might be migrating consumer stacks
   * in a follow-up). With this flag set, any such reference aborts.
   */
  strictCrossStack: boolean;
  /**
   * Auto-handle `AWS::ApiGatewayV2::Stage` and other resource types AWS
   * does NOT support in IMPORT changesets (`handlers: []` in the CFn
   * schema) but DOES support normal CREATE for. Default true: cdkd
   * skips these from phase 1, deletes the AWS-side resource between
   * phases, and lets CFn re-CREATE in phase 2 — brief unavailability
   * window (~10s for Stage; HttpApi endpoint URL is unchanged across
   * the migration because it embeds ApiId not StageName). When false,
   * cdkd blocks the export with a clear error instead.
   *
   * Commander parses `--no-recreate-import-unsupported` into
   * `recreateImportUnsupported: false`; the default (no flag) leaves
   * it `true`. See cdkd issue #307 for the design discussion.
   */
  recreateImportUnsupported: boolean;
}

/**
 * Resource types that are known to be incompatible with CloudFormation
 * `ChangeSetType=IMPORT`:
 *
 *   - `AWS::CDK::Metadata` is a CDK sentinel; not a real AWS resource and
 *     CFn refuses to import it.
 *   - `AWS::CloudFormation::Stack` is a nested stack reference; importing
 *     means re-creating the child stack, not adopting AWS resources.
 *   - `AWS::CloudFormation::CustomResource` is the CFn resource type CDK
 *     emits for `new cdk.CustomResource(...)` when no `resourceType` is
 *     passed. Functionally identical to `Custom::*` — Lambda-backed,
 *     no AWS resource state to adopt — and AWS rejects it from IMPORT
 *     changesets with the same error.
 *   - `Custom::*` are Lambda-backed Custom Resources. CFn cannot adopt the
 *     custom-resource state — invocation history lives in the provider
 *     Lambda, not in AWS resource state, so there is nothing to import.
 *
 * The list is intentionally narrow. Other resource types CFn may not yet
 * support for import are surfaced as errors by the CreateChangeSet call
 * itself; we do not try to maintain a closed allowlist here.
 */
const NEVER_IMPORTABLE_TYPES = new Set<string>([
  'AWS::CDK::Metadata',
  'AWS::CloudFormation::Stack',
]);

export function isNeverImportableType(resourceType: string): boolean {
  if (NEVER_IMPORTABLE_TYPES.has(resourceType)) return true;
  if (isCustomResourceType(resourceType)) return true;
  return false;
}

/**
 * Both `Custom::*` and `AWS::CloudFormation::CustomResource` denote
 * Lambda-backed Custom Resources. CDK emits the latter when
 * `new cdk.CustomResource(...)` is constructed without a `resourceType`;
 * users who supply one get `Custom::<Name>`. Both go through the
 * phase-2 CREATE path in `cdkd export`.
 */
function isCustomResourceType(resourceType: string): boolean {
  return (
    resourceType === 'AWS::CloudFormation::CustomResource' || resourceType.startsWith('Custom::')
  );
}

/**
 * Hardcoded fallback map for the per-resource-type primary identifier
 * property name. Used only when `DescribeType` fails (e.g. permissions
 * gap, throttling, or an obscure type that has no public registry entry).
 *
 * The string value is the SINGLE property name CFn expects in
 * `ResourcesToImport[].ResourceIdentifier`. For composite-identifier
 * types (`primaryIdentifier` length > 1) we do not have a fallback —
 * the call must succeed against `DescribeType` for those.
 *
 * Source: the `primaryIdentifier` field of each type's published
 * CloudFormation resource schema.
 */
const PRIMARY_IDENTIFIER_FALLBACK: Record<string, string> = {
  'AWS::S3::Bucket': 'BucketName',
  'AWS::IAM::Role': 'RoleName',
  'AWS::IAM::ManagedPolicy': 'PolicyArn',
  'AWS::IAM::User': 'UserName',
  'AWS::IAM::Group': 'GroupName',
  'AWS::IAM::InstanceProfile': 'InstanceProfileName',
  'AWS::Lambda::Function': 'FunctionName',
  'AWS::DynamoDB::Table': 'TableName',
  'AWS::SQS::Queue': 'QueueUrl',
  'AWS::SNS::Topic': 'TopicArn',
  'AWS::Logs::LogGroup': 'LogGroupName',
  'AWS::EC2::VPC': 'VpcId',
  'AWS::EC2::Subnet': 'SubnetId',
  'AWS::EC2::SecurityGroup': 'GroupId',
  'AWS::EC2::InternetGateway': 'InternetGatewayId',
  'AWS::EC2::RouteTable': 'RouteTableId',
  'AWS::EC2::NatGateway': 'NatGatewayId',
  'AWS::CloudFront::Distribution': 'Id',
  'AWS::CloudFront::CloudFrontOriginAccessIdentity': 'Id',
  'AWS::Route53::HostedZone': 'Id',
  'AWS::SecretsManager::Secret': 'Id',
  'AWS::Events::Rule': 'Arn',
  'AWS::Events::EventBus': 'Name',
  'AWS::ApiGateway::RestApi': 'RestApiId',
  'AWS::ApiGatewayV2::Api': 'ApiId',
  'AWS::CloudWatch::Alarm': 'AlarmName',
  'AWS::Kinesis::Stream': 'Name',
  'AWS::SSM::Parameter': 'Name',
  'AWS::StepFunctions::StateMachine': 'Arn',
  'AWS::Cognito::UserPool': 'UserPoolId',
  'AWS::ECR::Repository': 'RepositoryName',
};

/**
 * Per-type splitter for composite primary identifiers — CloudFormation
 * resource types whose `primaryIdentifier` has more than one field.
 *
 * Inputs:
 * - `physicalId`: the value `provider.create()` returned and cdkd persisted.
 * - `properties`: cdkd state's recorded properties for the resource. Some
 *   sub-resource types (ApiGwV2 Integration / Route, Lambda::Permission)
 *   only carry the secondary id in `physicalId` and rely on
 *   `properties[<parentField>]` (e.g. `properties.ApiId`) for the parent
 *   key. Splitters that don't need this can ignore the arg.
 *
 * Output: `CompositeIdResult` with two maps:
 * - `resourceIdentifier`: every `primaryIdentifier` field CFn schema declares.
 *   This is the map sent to CFn's `ResourcesToImport[].ResourceIdentifier`
 *   and MUST be complete (CFn rejects partial identifiers).
 * - `propertiesOverlay` (optional): subset of `resourceIdentifier` to write
 *   into the synth template's `Properties` block. Defaults to the full
 *   `resourceIdentifier` map (existing behavior for `AWS::ApiGateway::Method`
 *   / `AWS::ApiGateway::Resource` / `AWS::EC2::VPCGatewayAttachment` whose
 *   identifier fields ARE all writable Properties). Sub-resource types whose
 *   primaryIdentifier includes a generated-id field (`IntegrationId` /
 *   `RouteId` / Lambda::Permission's `Id`) MUST narrow to just the writable
 *   subset — those generated-id fields ARE listed in the CFn schema's
 *   `properties` block but tagged `readOnlyProperties`, so writing them
 *   via Properties at IMPORT changeset creation is rejected by CFn. The
 *   `resourceIdentifier` map sent to CFn's `ResourcesToImport[]` still
 *   carries the full set — the narrowing only affects template-Properties
 *   writing.
 *
 * cdkd's own per-type physicalId format is provider-defined (see
 * `src/provisioning/providers/*.ts` — most composites use `|` as the
 * separator; sub-resource types store only the secondary id). When the
 * per-type format does NOT match the order CFn expects (e.g.
 * `AWS::EC2::VPCGatewayAttachment` stores `IGW|VpcId` but CFn
 * primaryIdentifier is `[VpcId, InternetGatewayId]`), the splitter reorders
 * explicitly.
 *
 * Adding a new composite type: identify cdkd's physicalId format in the
 * matching `src/provisioning/providers/*.ts`, look up the CFn primary
 * identifier via `aws cloudformation describe-type` or the resource schema
 * docs, decide whether each field is a valid Property, and add an entry below.
 */
interface CompositeIdResult {
  resourceIdentifier: Record<string, string>;
  propertiesOverlay?: Record<string, string>;
}

type CompositeIdSplitter = (
  physicalId: string,
  properties: Record<string, unknown>
) => CompositeIdResult;

const COMPOSITE_ID_SPLITTERS: Record<string, CompositeIdSplitter> = {
  // cdkd stores `restApiId|resourceId|httpMethod` (apigateway-provider.ts);
  // CFn primary identifier is [RestApiId, ResourceId, HttpMethod] — same
  // order, and all three are writable Properties of AWS::ApiGateway::Method.
  'AWS::ApiGateway::Method': (id) => {
    const parts = id.split('|');
    if (parts.length !== 3) {
      throw new Error(
        `expected 3 parts (restApiId|resourceId|httpMethod), got ${parts.length}: '${id}'`
      );
    }
    const map = { RestApiId: parts[0]!, ResourceId: parts[1]!, HttpMethod: parts[2]! };
    return { resourceIdentifier: map };
  },
  // cdkd stores `restApiId|resourceId` (apigateway-provider.ts);
  // CFn primary identifier is [RestApiId, ResourceId] — both are writable
  // Properties of AWS::ApiGateway::Resource.
  'AWS::ApiGateway::Resource': (id) => {
    const parts = id.split('|');
    if (parts.length !== 2) {
      throw new Error(`expected 2 parts (restApiId|resourceId), got ${parts.length}: '${id}'`);
    }
    const map = { RestApiId: parts[0]!, ResourceId: parts[1]! };
    return { resourceIdentifier: map };
  },
  // cdkd stores `IGW|VpcId` (ec2-provider.ts);
  // CFn primary identifier is [VpcId, InternetGatewayId] — DIFFERENT order
  // from cdkd. Splitter reorders explicitly. Both are writable Properties.
  'AWS::EC2::VPCGatewayAttachment': (id) => {
    const parts = id.split('|');
    if (parts.length !== 2) {
      throw new Error(`expected 2 parts (IGW|VpcId), got ${parts.length}: '${id}'`);
    }
    const map = { VpcId: parts[1]!, InternetGatewayId: parts[0]! };
    return { resourceIdentifier: map };
  },
  // cdkd stores just `IntegrationId` (apigatewayv2-provider.ts); the parent
  // `ApiId` lives in cdkd state's properties (`properties.ApiId`). CFn primary
  // identifier is [ApiId, IntegrationId]. ApiId IS a writable Property
  // (already in synth template via Ref); IntegrationId is tagged
  // `readOnlyProperties: ['/properties/IntegrationId']` in the CFn schema —
  // exclude it from propertiesOverlay so CFn doesn't reject writing a
  // read-only property at changeset-create.
  'AWS::ApiGatewayV2::Integration': (physicalId, properties) => {
    const apiId = readStringProperty(properties, 'ApiId', 'AWS::ApiGatewayV2::Integration');
    return {
      resourceIdentifier: { ApiId: apiId, IntegrationId: physicalId },
      propertiesOverlay: { ApiId: apiId },
    };
  },
  // cdkd stores just `RouteId` (apigatewayv2-provider.ts); parent `ApiId`
  // comes from properties. CFn primary identifier is [ApiId, RouteId]. Same
  // overlay narrowing as Integration above.
  'AWS::ApiGatewayV2::Route': (physicalId, properties) => {
    const apiId = readStringProperty(properties, 'ApiId', 'AWS::ApiGatewayV2::Route');
    return {
      resourceIdentifier: { ApiId: apiId, RouteId: physicalId },
      propertiesOverlay: { ApiId: apiId },
    };
  },
  // NOTE: `AWS::ApiGatewayV2::Stage` is intentionally NOT in this map.
  // (1) AWS reports its primaryIdentifier as `['/properties/Id']` (single-key),
  //     so cdkd's single-key resolution path handles it without a splitter.
  // (2) But AWS CloudFormation does NOT support `AWS::ApiGatewayV2::Stage` in
  //     IMPORT changesets (CreateChangeSet rejects with "ResourceTypes
  //     [AWS::ApiGatewayV2::Stage] are not supported for Import"). This means
  //     `cdkd export` cannot complete on any stack that includes an HttpApi
  //     (CDK auto-creates a `$default` Stage). Tracked in a follow-up issue
  //     (link in PR description); the workaround design is open
  //     (pre-delete + phase-2-CREATE vs hard-block-with-clear-error).
  // cdkd stores `StatementId` (lambda-permission-provider.ts:124); for state
  // entries written by the older CC-API path (pre-SDK-provider), physicalId
  // may instead be the legacy `<functionArn>|<statementId>` shape — the
  // provider's own delete / update / getAttribute paths normalize via
  // `physicalId.split('|').pop()` (see lambda-permission-provider.ts:160 /
  // 222 / 290). Mirror that here so legacy state still produces the
  // correct CFn Id field; otherwise CFn IMPORT's identifier-match would
  // compare `Id: '<arn>|<sid>'` against the AWS-current Sid and reject.
  //
  // CFn primary identifier is [FunctionName, Id] (note: CFn schema calls
  // the field `Id`, not `StatementId`). FunctionName IS a writable
  // Property; `Id` is tagged `readOnlyProperties: ['/properties/Id']` in
  // the CFn schema (it's set at create time by AWS, not by the user).
  // Narrow overlay to FunctionName so CFn doesn't reject writing read-only
  // `Id` at changeset-create.
  'AWS::Lambda::Permission': (physicalId, properties) => {
    const functionName = readStringProperty(properties, 'FunctionName', 'AWS::Lambda::Permission');
    const statementId = physicalId.includes('|') ? physicalId.split('|').pop()! : physicalId;
    return {
      resourceIdentifier: { FunctionName: functionName, Id: statementId },
      propertiesOverlay: { FunctionName: functionName },
    };
  },
};

function readStringProperty(
  properties: Record<string, unknown>,
  key: string,
  resourceType: string
): string {
  const v = properties[key];
  if (typeof v !== 'string' || !v) {
    throw new Error(
      `cdkd state's properties for ${resourceType} is missing '${key}' (the parent identifier ` +
        `required to build the CFn ResourceIdentifier map). State entry may be corrupt or written ` +
        `by an older cdkd binary; re-deploy the resource to refresh state.`
    );
  }
  return v;
}

/**
 * Returns true if cdkd has a registered splitter for the given type. Used
 * by `resolveResourceIdentifier` to decide between the single-key and
 * composite paths, and by tests to assert coverage.
 */
export function hasCompositeIdSplitter(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMPOSITE_ID_SPLITTERS, resourceType);
}

/**
 * Exported for unit tests — apply the registered splitter for `resourceType`
 * to `physicalId` (with the resource's recorded properties for splitters
 * that need a parent identifier from state) and return the resulting
 * `CompositeIdResult`. Throws when no splitter is registered (same shape
 * as `resolveResourceIdentifier`'s composite path).
 */
export function splitCompositePhysicalId(
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown> = {}
): CompositeIdResult {
  const splitter = COMPOSITE_ID_SPLITTERS[resourceType];
  if (!splitter) {
    throw new Error(`no composite-id splitter registered for ${resourceType}`);
  }
  return splitter(physicalId, properties);
}

interface ImportPlanEntry {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /**
   * The `ResourceIdentifier` map CFn IMPORT expects in `ResourcesToImport[].ResourceIdentifier`.
   * Single-key types have a one-entry object (`{ BucketName: 'my-bucket' }`); composite types
   * have one entry per `primaryIdentifier` field (`{ RestApiId: '...', ResourceId: '...' }`).
   */
  resourceIdentifier: Record<string, string>;
  /**
   * Subset of `resourceIdentifier` to also write into the synth template's
   * `Properties` block (so CFn IMPORT's identifier-match check passes
   * against the cdkd-prefixed physical id). When omitted, defaults to the
   * full `resourceIdentifier` map at the overlay site. Sub-resource types
   * whose primaryIdentifier includes an AWS-generated, `readOnlyProperties`
   * field (e.g. `AWS::ApiGatewayV2::Integration.IntegrationId`) narrow
   * this to just the writable subset, so CFn IMPORT doesn't reject the
   * changeset on a read-only-property write.
   */
  propertiesOverlay?: Record<string, string>;
}

/**
 * Entry in the "delete from AWS before phase-2 UPDATE so CFn can re-CREATE
 * fresh" list. Used for resource types AWS does NOT support in IMPORT
 * changesets but DOES support normal CREATE for — currently just
 * `AWS::ApiGatewayV2::Stage` (handlers: []), which is auto-emitted by
 * CDK's `HttpApi` construct as `$default`.
 *
 * The flow: phase-1 IMPORT skips these resources entirely. Between
 * phase 1 and phase 2, cdkd issues a per-type SDK delete call against
 * the AWS-side resource. Phase 2 then sees the resource in the full
 * synth template and CFn CREATEs it fresh. There IS a brief
 * unavailability window between the SDK delete and CFn's CREATE
 * (typically ~10s for Stage); for `$default` HttpApi Stage this is
 * fine because the API URL embeds ApiId + region, not StageName, so
 * the endpoint URL is unchanged across the migration.
 *
 * Tracked design discussion: cdkd issue #307.
 */
export interface RecreateBeforePhase2Entry {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /** cdkd state's recorded properties — supplies parent identifiers (ApiId, etc.) to the SDK delete call. */
  properties: Record<string, unknown>;
}

/**
 * Resource types AWS does NOT support in IMPORT changesets but DOES
 * support normal CREATE for. cdkd handles these via a pre-delete + phase-2
 * CREATE dance (see {@link RecreateBeforePhase2Entry}). When the user
 * passes `--no-recreate-import-unsupported`, resources of these types
 * are hard-blocked instead with a clear error message.
 *
 * Verified via `aws cloudformation describe-type --type RESOURCE
 * --type-name <T> | jq .handlers` — types with `handlers: []` are
 * candidates. Currently only `AWS::ApiGatewayV2::Stage` qualifies (every
 * sibling ApiGwV2 type has `[create, delete, list, read, update]`).
 */
const IMPORT_UNSUPPORTED_RECREATABLE_TYPES: ReadonlySet<string> = new Set([
  // AWS::ApiGatewayV2::Stage — `handlers: []`. HttpApi auto-emits `$default`.
  'AWS::ApiGatewayV2::Stage',
  // AWS::IAM::Policy — `handlers: ['create', 'delete', 'update']` (no `read`/
  // `list`). Inline policies attached to roles / users / groups don't have a
  // first-class AWS resource id, so CFn IMPORT can't look them up. cdkd's
  // own IAMPolicyProvider issues `iam:PutRolePolicy` / `PutUserPolicy` /
  // `PutGroupPolicy` per attachment target; CFn phase-2 CREATE uses the
  // exact same APIs, so pre-delete + phase-2-CREATE round-trips cleanly.
  // CDK auto-emits this type for L2 grants (ECS Task Execution Role
  // ECR pull policy, Lambda execution role inline policies, etc.).
  'AWS::IAM::Policy',
]);

/**
 * Returns true if cdkd treats the resource type as "AWS doesn't support
 * IMPORT but does support CREATE" — handled via pre-delete + phase-2-CREATE
 * (see {@link IMPORT_UNSUPPORTED_RECREATABLE_TYPES}). Exported for unit tests
 * and for ad-hoc inspection.
 */
export function isImportUnsupportedRecreatableType(resourceType: string): boolean {
  return IMPORT_UNSUPPORTED_RECREATABLE_TYPES.has(resourceType);
}

/**
 * Per-type AWS SDK delete handler invoked between phase-1 IMPORT and
 * phase-2 UPDATE so CFn's phase-2 CREATE doesn't collide with the
 * already-existing AWS-side resource. Each handler reads the parent
 * identifier (`ApiId` etc.) from `properties` and the secondary id
 * from `physicalId`, then issues the appropriate Delete API call.
 *
 * Errors propagate to the caller — a failed pre-delete is fatal
 * because phase 2 would then collide with the still-present AWS
 * resource. cdkd state and the post-phase-1 CFn stack are preserved
 * so the user can fix the underlying cause (typically permissions)
 * and re-run.
 */
type PreDeleteHandler = (entry: RecreateBeforePhase2Entry) => Promise<void>;

const PRE_DELETE_HANDLERS: Record<string, PreDeleteHandler> = {
  'AWS::ApiGatewayV2::Stage': async (entry) => {
    // ApiGatewayV2Client isn't in src/utils/aws-clients.ts — lazy-init
    // inline (same pattern as ApiGatewayV2Provider.getClient).
    const { ApiGatewayV2Client, DeleteStageCommand, NotFoundException } =
      await import('@aws-sdk/client-apigatewayv2');
    const apiId = entry.properties['ApiId'];
    if (typeof apiId !== 'string' || !apiId) {
      throw new Error(
        `cdkd state's properties for ${entry.logicalId} (${entry.resourceType}) is missing 'ApiId'`
      );
    }
    const client = new ApiGatewayV2Client({});
    try {
      await client.send(new DeleteStageCommand({ ApiId: apiId, StageName: entry.physicalId }));
    } catch (err) {
      // Idempotent on already-deleted: a retry after a partial pre-delete
      // failure (or a concurrent operator action) would otherwise abort the
      // export. AWS returns NotFoundException for both "ApiId not found"
      // and "Stage not found"; either way the goal state (Stage gone) is
      // already achieved. Other errors propagate.
      if (err instanceof NotFoundException) {
        return;
      }
      throw err;
    }
  },
  'AWS::IAM::Policy': async (entry) => {
    // Mirrors IAMPolicyProvider.delete (src/provisioning/providers/
    // iam-policy-provider.ts): inline policy attachments are stored per-
    // target via PutRolePolicy/PutUserPolicy/PutGroupPolicy, so deletion
    // is per-target too. State carries Roles/Users/Groups arrays
    // capturing the attachment set at deploy time.
    const {
      IAMClient,
      DeleteRolePolicyCommand,
      DeleteUserPolicyCommand,
      DeleteGroupPolicyCommand,
      NoSuchEntityException,
    } = await import('@aws-sdk/client-iam');

    // physicalId is either the bare policy name (SDK provider format) or
    // legacy `policyName:roleName` (CC API pre-SDK-provider state). The
    // SDK provider's own delete normalizes via the same split; mirror it
    // so pre-v0.74-ish state still produces the correct policy name.
    const policyName = entry.physicalId.includes(':')
      ? entry.physicalId.split(':')[0]
      : entry.physicalId;
    if (!policyName) {
      throw new Error(
        `cdkd state's physicalId for ${entry.logicalId} (${entry.resourceType}) is empty / invalid`
      );
    }

    const roles = entry.properties['Roles'] as string[] | undefined;
    const users = entry.properties['Users'] as string[] | undefined;
    const groups = entry.properties['Groups'] as string[] | undefined;
    const hasAttachment = (roles?.length ?? 0) + (users?.length ?? 0) + (groups?.length ?? 0) > 0;
    if (!hasAttachment) {
      throw new Error(
        `cdkd state's properties for ${entry.logicalId} (${entry.resourceType}) has no ` +
          `Roles/Users/Groups attachment recorded — cannot pre-delete the inline policy. ` +
          `State may be from a pre-v0.74 cdkd binary; re-run \`cdkd state refresh-observed\` ` +
          `before export.`
      );
    }

    const client = new IAMClient({});

    // Each per-target send is idempotent on NoSuchEntityException
    // (matches IAMPolicyProvider.delete; covers partial-retry safety
    // after a previous pre-delete attempt succeeded for some targets).
    // Other errors propagate so phase 2 doesn't proceed against a
    // policy still attached to AWS.
    const deleteSafely = async (op: () => Promise<unknown>): Promise<void> => {
      try {
        await op();
      } catch (err) {
        if (err instanceof NoSuchEntityException) return;
        throw err;
      }
    };

    for (const roleName of roles ?? []) {
      await deleteSafely(() =>
        client.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }))
      );
    }
    for (const userName of users ?? []) {
      await deleteSafely(() =>
        client.send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: policyName }))
      );
    }
    for (const groupName of groups ?? []) {
      await deleteSafely(() =>
        client.send(new DeleteGroupPolicyCommand({ GroupName: groupName, PolicyName: policyName }))
      );
    }
  },
};

/**
 * Exported for unit testing — look up the pre-delete handler for
 * `resourceType` and invoke it against `entry`. Throws when no handler
 * is registered (same shape as the inline call site).
 */
export async function invokePreDeleteHandler(
  resourceType: string,
  entry: RecreateBeforePhase2Entry
): Promise<void> {
  const handler = PRE_DELETE_HANDLERS[resourceType];
  if (!handler) {
    throw new Error(`no pre-delete handler registered for ${resourceType}`);
  }
  await handler(entry);
}

async function exportCommand(stackArg: string | undefined, options: ExportOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
    process.env['CDKD_NO_LIVE'] = '1';
  }

  warnIfDeprecatedRegion(options);

  // Gate transient context overrides. CLI `-c key=value` flags are
  // visible to cdkd's synth but NOT persisted to cdk.json /
  // cdk.context.json, so a subsequent `cdk deploy` would synthesize a
  // different template and CFn would replace or update resources.
  // Default-refuse forces the user to either move the overrides into
  // cdk.json (durable) or explicitly accept the risk with
  // `--accept-transient-context`. Done up front, before synth, so the
  // error message is the very first thing the user sees.
  refuseTransientContextIfUnsafe(options);

  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
  const stateBucket = await resolveStateBucketWithDefault(options.stateBucket, region);

  if (options.region) {
    process.env['AWS_REGION'] = options.region;
    process.env['AWS_DEFAULT_REGION'] = options.region;
  }
  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: options.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();
    const lockManager = new LockManager(awsClients.s3, stateConfig);

    // Synthesize the CDK app to get the template (or read a user-supplied
    // template file). cdkd state does not persist the original template
    // body, so synth is required even though we only inspect the cdkd
    // state for physical IDs.
    let template: Record<string, unknown>;
    let resolvedStackName: string;
    let synthedRegion: string | undefined;
    // Set when synth runs (not when --template is used). Captures all
    // stacks in the user's CDK app, used by the cross-stack consumer
    // scan to detect Fn::GetStackOutput references to the exporting
    // stack from sibling stacks.
    let allSynthStacks: Array<{ stackName: string; template: unknown }> = [];

    if (options.template) {
      // User-supplied template path: still need a stack name to load state.
      if (!stackArg) {
        throw new Error(
          '--template requires a stack name as a positional argument to identify the cdkd state record.'
        );
      }
      template = parseTemplateFile(options.template);
      resolvedStackName = stackArg;
    } else {
      const appCmd = options.app || resolveApp();
      if (!appCmd) {
        throw new Error(
          "'cdkd export' requires a CDK app (pass --app or set it in cdk.json) " +
            'OR a pre-rendered CFn template (--template <path>).'
        );
      }
      logger.info('Synthesizing CDK app to read template...');
      const synthesizer = new Synthesizer();
      const context = parseContextOptions(options.context);
      const result = await synthesizer.synthesize({
        app: appCmd,
        output: options.output || 'cdk.out',
        ...(Object.keys(context).length > 0 && { context }),
      });

      let stackInfo;
      if (stackArg) {
        stackInfo = result.stacks.find(
          (s) => s.stackName === stackArg || s.displayName === stackArg
        );
        if (!stackInfo) {
          throw new Error(
            `Stack '${stackArg}' not found in synthesized app. ` +
              `Available: ${result.stacks.map((s) => s.stackName).join(', ')}`
          );
        }
      } else if (result.stacks.length === 1) {
        stackInfo = result.stacks[0]!;
      } else {
        throw new Error(
          `Multiple stacks found: ${result.stacks.map((s) => s.stackName).join(', ')}. ` +
            `Specify the stack name as a positional argument.`
        );
      }
      template = stackInfo.template as unknown as Record<string, unknown>;
      resolvedStackName = stackInfo.stackName;
      synthedRegion = stackInfo.region;
      allSynthStacks = result.stacks.map((s) => ({
        stackName: s.stackName,
        template: s.template,
      }));
    }

    const cfnStackName = options.cfnStackName ?? resolvedStackName;
    const targetRegion = await pickStackRegion(
      stateBackend,
      resolvedStackName,
      synthedRegion,
      options.stackRegion
    );

    logger.info(
      `Migrating cdkd stack '${resolvedStackName}' (${targetRegion}) → CloudFormation stack '${cfnStackName}'`
    );

    // Refuse if a CFn stack with that name already exists. CFn IMPORT's
    // CreateChangeSet either creates a new stack (CHANGE_SET_TYPE=IMPORT
    // against a non-existent stack) or attaches imports to an existing
    // one; mixing the two cases silently would surprise users.
    await assertCfnStackAbsent(awsClients.cloudFormation, cfnStackName);

    // Load cdkd state for the target stack.
    const stateData = await stateBackend.getState(resolvedStackName, targetRegion);
    if (!stateData) {
      throw new Error(
        `No cdkd state found for stack '${resolvedStackName}' (${targetRegion}). ` +
          `Nothing to migrate.`
      );
    }
    const { state, etag, migrationPending } = stateData;

    // Acquire the lock before any AWS write. Dry-run skips the lock so it
    // is a pure read.
    //
    // `acquireLock` returns `false` (rather than throwing) when another
    // live, non-expired lock holder exists. Most cdkd commands discard
    // this return value, but export is uniquely irreversible — once the
    // CFn IMPORT changeset executes and cdkd state is deleted, we cannot
    // back out — so we refuse the operation rather than racing a
    // concurrent `cdkd deploy` / `cdkd destroy` on the same stack.
    const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
    if (!options.dryRun) {
      const acquired = await lockManager.acquireLock(
        resolvedStackName,
        targetRegion,
        owner,
        'export'
      );
      if (!acquired) {
        throw new Error(
          `Could not acquire lock for stack '${resolvedStackName}' (${targetRegion}) — ` +
            `another cdkd process holds it. Wait for it to finish, or run ` +
            `'cdkd force-unlock ${resolvedStackName}' if you are certain no other process is active.`
        );
      }
    }

    try {
      // Build the import plan: cdkd state × template resources, classified
      // into phase1 (importable) / phase2 (Custom::* CFn will CREATE) /
      // recreateBeforePhase2 (Stage — IMPORT-unsupported, pre-delete + CFn
      // CREATE in phase 2) / blocked (anything else — aborts the run).
      const { phase1Imports, phase2Creates, recreateBeforePhase2, blocked } = await buildImportPlan(
        state,
        template,
        awsClients.cloudFormation,
        {
          recreateImportUnsupported: options.recreateImportUnsupported,
        }
      );

      // `blocked` resources are genuinely unfixable (nested stacks, missing
      // state, etc.) — nothing the user can do at runtime resolves them.
      // Hard-fail in both dry-run and real-run paths; printing the plan
      // here is unhelpful because there is no path forward.
      if (blocked.length > 0) {
        logger.error('The following resources block migration:');
        for (const b of blocked) {
          logger.error(`  - ${b.logicalId} (${b.resourceType}): ${b.reason}`);
        }
        throw new Error(
          `${blocked.length} resource(s) block migration. Either destroy them first ` +
            `(cdkd destroy / cdkd state destroy cherry-picked), or remove them from the ` +
            `CDK app and re-synthesize.`
        );
      }

      if (
        phase1Imports.length === 0 &&
        phase2Creates.length === 0 &&
        recreateBeforePhase2.length === 0
      ) {
        logger.warn('No resources to migrate — cdkd state is empty.');
        return;
      }
      if (phase1Imports.length === 0) {
        throw new Error(
          'No importable resources in the template. CloudFormation IMPORT changeset ' +
            'requires at least one importable resource for phase 1.'
        );
      }

      printPlan(phase1Imports, cfnStackName);
      if (phase2Creates.length > 0) {
        logger.info(`Phase 2 will CREATE ${phase2Creates.length} non-importable resource(s):`);
        for (const p of phase2Creates) {
          logger.info(`  ${p.logicalId} (${p.resourceType})`);
        }
        logger.info('');
      }
      if (recreateBeforePhase2.length > 0) {
        logger.info(
          `Phase 2 will also re-CREATE ${recreateBeforePhase2.length} ` +
            `IMPORT-unsupported resource(s) after cdkd deletes the AWS-side resource:`
        );
        for (const r of recreateBeforePhase2) {
          logger.info(`  ${r.logicalId} (${r.resourceType}) — physicalId: ${r.physicalId}`);
        }
        logger.info(
          '  Brief unavailability window per type (~10s for Stage; HttpApi endpoint URL ' +
            'is unchanged because it embeds ApiId, not StageName. IAM::Policy: the inline ' +
            'policy attachment is dropped from each Role/User/Group between phases — any ' +
            'in-flight AWS API call that depends on the granted permission will fail until ' +
            'CFn re-CREATEs in phase 2). Pass --no-recreate-import-unsupported to block instead.'
        );
        logger.info('');
      }

      // `--include-non-importable` is a real-run safety gate (Custom Resource
      // onCreate re-invocation needs to be idempotent — see CLAUDE.md). On
      // `--dry-run` we WARN instead of hard-erroring so the user sees the
      // full plan + the gate they'll need to flip for the real run. Erroring
      // out before printPlan defeats the point of dry-run.
      if (options.dryRun) {
        if (phase2Creates.length > 0 && !options.includeNonImportable) {
          logger.warn(
            `${phase2Creates.length} non-importable resource(s) detected (Custom::*). ` +
              `A real run (without --dry-run) would require --include-non-importable ` +
              `to run a 2-phase migration: phase 1 imports the importable resources; ` +
              `phase 2 CFn-CREATEs the non-importable ones (re-invoking each Custom ` +
              `Resource's backing Lambda onCreate handler — make sure those are idempotent).`
          );
        }
        logger.info('--dry-run: no CloudFormation changeset will be created.');
        return;
      }

      // Real run: hard error on missing --include-non-importable so the user
      // explicitly opts into the CR re-invocation semantics before phase 2
      // touches AWS.
      if (phase2Creates.length > 0 && !options.includeNonImportable) {
        logger.error('The following resources cannot be imported into CloudFormation:');
        for (const p of phase2Creates) {
          logger.error(`  - ${p.logicalId} (${p.resourceType}): CFn cannot import this type`);
        }
        throw new Error(
          `${phase2Creates.length} non-importable resource(s) detected (Custom::*). ` +
            `Pass --include-non-importable to run a 2-phase migration: phase 1 imports ` +
            `the importable resources; phase 2 CFn-CREATEs the non-importable ones ` +
            `(re-invoking each Custom Resource's backing Lambda onCreate handler — ` +
            `make sure those are idempotent). Or destroy these resources first.`
        );
      }

      if (!options.yes) {
        const phase2Note =
          phase2Creates.length > 0
            ? ` Phase 2 will then CREATE ${phase2Creates.length} non-importable resource(s) ` +
              `(invoking each Custom Resource's onCreate handler).`
            : '';
        const recreateNote =
          recreateBeforePhase2.length > 0
            ? ` cdkd will also DELETE ${recreateBeforePhase2.length} AWS resource(s) ` +
              `between phases so CFn can re-CREATE them in phase 2 (brief unavailability ` +
              `window — see plan above for the affected resources).`
            : '';
        // "AWS resources are unchanged on import" is the simple case. When
        // pre-delete is in play, that claim is false for the recreate-targets
        // (they're deleted then re-CREATEd; AWS resource ids stay the same
        // post-CREATE, but there's a brief window where they don't exist).
        // Use the more specific wording in that case.
        const unchangedClaim =
          recreateBeforePhase2.length > 0
            ? ` All other AWS resources are unchanged on import.`
            : ` AWS resources are unchanged on import.`;
        const ok = await confirmPrompt(
          `Create CloudFormation stack '${cfnStackName}' by importing ${phase1Imports.length} ` +
            `resource(s) from cdkd state '${resolvedStackName}' (${targetRegion})?` +
            phase2Note +
            recreateNote +
            unchangedClaim +
            ` cdkd state for '${resolvedStackName}' will be deleted on success.`
        );
        if (!ok) {
          logger.info('Migration cancelled. cdkd state and CloudFormation are unchanged.');
          return;
        }
      }

      // Drift baseline pre-flight. cdkd state schema v3 carries
      // `observedProperties` (the AWS-current snapshot at last
      // deploy / import), which is the baseline `cdkd drift` compares
      // against. If the baseline is missing — older state schemas or
      // resources written by providers without `readCurrentState` —
      // the user has no reliable way to verify the CDK template matches
      // AWS reality before the migration. Surface that as a warning so
      // they can re-run `cdkd state refresh-observed` first if drift
      // matters.
      reportDriftBaselineGaps(state, logger);

      // Cross-stack consumer scan. After this stack moves to CFn, its
      // outputs live in CFn (not cdkd state), so cdkd's
      // `Fn::GetStackOutput` resolver — which reads cdkd state — can no
      // longer find them. Warn (or refuse with --strict-cross-stack) when
      // any sibling stack in the same CDK app references this one. The
      // scan only sees stacks in `allSynthStacks` — when the user passes
      // --template, we skip the scan because we have no sibling templates.
      if (allSynthStacks.length > 0) {
        const crossRefs = scanCrossStackReferences(allSynthStacks, resolvedStackName);
        if (crossRefs.length > 0) {
          const lines = crossRefs.map(
            (r) =>
              `  ${r.consumerStackName} → ${resolvedStackName}.${r.outputName} at ${r.location}`
          );
          if (options.strictCrossStack) {
            throw new Error(
              `Refusing to export: ${crossRefs.length} cross-stack reference(s) to ` +
                `${resolvedStackName} found in sibling stacks. After migration, those ` +
                `references will break (cdkd's Fn::GetStackOutput reads cdkd state; the ` +
                `migrated stack's outputs live in CFn). Migrate consumers first, or remove ` +
                `the references, or drop --strict-cross-stack to proceed with a warning:\n` +
                lines.join('\n')
            );
          }
          logger.warn(
            `${crossRefs.length} cross-stack reference(s) to '${resolvedStackName}' from ` +
              `sibling stacks. These will break the next time those stacks deploy via cdkd ` +
              `(cdkd's Fn::GetStackOutput resolver reads cdkd state; the migrated stack's ` +
              `outputs are now in CFn). Plan multi-stack migrations from the leaves up.`
          );
          for (const line of lines) logger.warn(line);
        }
      }

      // Resolve template Parameters once (used by both phase 1 and phase 2).
      // Aborts here if the template has required parameters without
      // defaults that the user did not supply via --parameter.
      const userParameters = parseParameterOverrides(options.parameter);
      const { parameters: cfnParameters, missing } = resolveTemplateParameters(
        template,
        userParameters
      );
      if (missing.length > 0) {
        throw new Error(
          `Template requires parameter(s) without defaults: ${missing.join(', ')}. ` +
            `Pass each one as --parameter Key=Value (or set a Default in the CDK code).`
        );
      }

      // Phase 1: IMPORT changeset. CFn IMPORT requires DeletionPolicy on
      // every resource (AWS hard requirement). CDK-synth templates only
      // emit DeletionPolicy when the user sets RemovalPolicy explicitly,
      // so we inject DeletionPolicy: Retain on resources that lack the
      // attribute. Retain is the safest default — if the user runs
      // `aws cloudformation delete-stack` BEFORE the post-export `cdk
      // deploy`, no AWS resource is destroyed. The first subsequent
      // `cdk deploy` resets DeletionPolicy to the user's CDK-declared
      // value (or absent), so the injection is transient.
      const phase1Template = filterTemplateForImport(template, phase1Imports);
      const injectedCount = injectDeletionPolicyForImport(phase1Template);
      if (injectedCount > 0) {
        logger.info(
          `Injected DeletionPolicy: Retain on ${injectedCount} resource(s) without an ` +
            `explicit DeletionPolicy (required by CFn IMPORT). The first \`cdk deploy\` ` +
            `after export will reset each to your CDK-declared value.`
        );
      }
      await executeImportChangeSet(
        awsClients.cloudFormation,
        cfnStackName,
        phase1Template,
        phase1Imports,
        cfnParameters
      );

      logger.info(
        `✓ Phase 1: CloudFormation stack '${cfnStackName}' created via IMPORT. ` +
          `${phase1Imports.length} resource(s) imported.`
      );

      // Pre-delete IMPORT-unsupported resources (currently just
      // AWS::ApiGatewayV2::Stage). These were skipped from phase 1
      // because AWS rejects them in IMPORT changesets. The synth template
      // still includes them, so phase-2 UPDATE will see them as new and
      // CFn will issue CREATE — but only AFTER we delete the AWS-side
      // resource here, or CFn's CreateStage would collide with the
      // already-existing one. Failure here is fatal: cdkd state is intact
      // (release happens in outer finally) but a partial pre-delete may
      // leave AWS in a half-state — the recovery path is to fix the
      // underlying issue (permissions, AWS API throttling) and re-run
      // the export command. The lock prevents concurrent cdkd activity.
      if (recreateBeforePhase2.length > 0) {
        for (const entry of recreateBeforePhase2) {
          const handler = PRE_DELETE_HANDLERS[entry.resourceType];
          if (!handler) {
            throw new Error(
              `No pre-delete handler registered for ${entry.resourceType} ` +
                `(${entry.logicalId}). This is a cdkd bug — the resource is in ` +
                `IMPORT_UNSUPPORTED_RECREATABLE_TYPES but lacks a PRE_DELETE_HANDLERS entry. ` +
                `Phase 1 IMPORT already succeeded; cdkd state is intact. To recover, ` +
                `delete the AWS resource manually and run the phase 2 UPDATE.`
            );
          }
          logger.info(
            `Pre-deleting AWS resource for ${entry.logicalId} (${entry.resourceType}) ` +
              `so CFn can re-CREATE in phase 2...`
          );
          try {
            await handler(entry);
            logger.info(`  ✓ deleted ${entry.physicalId}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `Phase 1 (IMPORT) succeeded; pre-delete of ${entry.logicalId} ` +
                `(${entry.resourceType}, physicalId: ${entry.physicalId}) failed: ${msg}\n\n` +
                `The CloudFormation stack '${cfnStackName}' contains the phase-1 imports ` +
                `but the IMPORT-unsupported resources (${recreateBeforePhase2.length} total) ` +
                `still exist in AWS unmanaged. cdkd state is UNCHANGED. Re-running ` +
                `\`cdkd export\` does NOT work — the existing-stack check rejects it. ` +
                `To recover manually:\n` +
                `  1. Fix the failure cause (typically IAM permissions for the underlying ` +
                `     AWS API — e.g. apigatewayv2:DeleteStage for AWS::ApiGatewayV2::Stage).\n` +
                `  2. Delete the remaining AWS-side IMPORT-unsupported resources by hand:\n` +
                `       aws apigatewayv2 delete-stage --api-id <ApiId> --stage-name <StageName>\n` +
                `     (one per entry in the pre-delete list logged above).\n` +
                `  3. Run the phase-2 UPDATE manually with the full synth template:\n` +
                `       aws cloudformation create-change-set --stack-name ${cfnStackName} \\\n` +
                `         --change-set-name cdkd-phase2-retry --change-set-type UPDATE \\\n` +
                `         --template-body file://<full-template.json>\n` +
                `  4. Once phase 2 succeeds, run: cdkd state orphan ${resolvedStackName}\n` +
                `     to clean up cdkd's stale state record.`
            );
          }
        }
      }

      // Phase 2: UPDATE changeset to add the non-importable resources via
      // CREATE. Skipped when there are none. A phase-2 failure leaves the
      // CFn stack in a partial state (phase 1 resources imported, phase 2
      // missing) and cdkd state intact so the user can recover manually
      // via `aws cloudformation update-stack` + `cdkd state orphan`.
      const phase2Count = phase2Creates.length + recreateBeforePhase2.length;
      if (phase2Count > 0) {
        try {
          // Apply the phase-1 overlay onto each imported resource in the
          // phase-2 template — without this, CFn sees "Name property
          // removal" between phase-1 (overlayed) and phase-2 (raw synth)
          // and silently REPLACES every imported resource whose Name is
          // an immutable property (IAM Role, S3 Bucket, etc.). See
          // applyImportOverlayForPhase2's docstring for the empirical
          // motivation (cdk-sample 2026-05-12 incident: 24 resources
          // silently REPLACED during phase-2 cleanup).
          const phase2Template = applyImportOverlayForPhase2(template, phase1Imports);
          await executeUpdateChangeSet(
            awsClients.cloudFormation,
            cfnStackName,
            phase2Template,
            cfnParameters
          );
          const parts: string[] = [];
          if (phase2Creates.length > 0) {
            parts.push(`${phase2Creates.length} non-importable resource(s) CREATEd`);
          }
          if (recreateBeforePhase2.length > 0) {
            parts.push(`${recreateBeforePhase2.length} IMPORT-unsupported resource(s) re-CREATEd`);
          }
          logger.info(`✓ Phase 2: ${parts.join('; ')}.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const recreateNote =
            recreateBeforePhase2.length > 0
              ? `  - cdkd deleted ${recreateBeforePhase2.length} AWS resource(s) before ` +
                `phase 2 (Stage etc.). They are gone in AWS but absent from the CFn stack. ` +
                `Running phase 2 UPDATE manually will CFn-CREATE them fresh.\n`
              : '';
          throw new Error(
            `Phase 1 (IMPORT) succeeded; phase 2 (UPDATE) failed: ${msg}\n\n` +
              `The CloudFormation stack '${cfnStackName}' now contains the imported ` +
              `resources but is missing ${phase2Count} resource(s) (${phase2Creates.length} ` +
              `Custom Resource(s) + ${recreateBeforePhase2.length} IMPORT-unsupported). ` +
              `cdkd state is UNCHANGED so you can inspect what's in it, but DO NOT run ` +
              `\`cdkd deploy\` against this stack (the imported resources are now ` +
              `CFn-managed). To recover:\n` +
              recreateNote +
              `  1. Fix the failure cause (typically an onCreate Lambda error).\n` +
              `  2. Re-run the phase 2 UPDATE manually with the full synth template:\n` +
              `       aws cloudformation create-change-set --stack-name ${cfnStackName} \\\n` +
              `         --change-set-name cdkd-phase2-retry --change-set-type UPDATE \\\n` +
              `         --template-body file://<full-template.json>\n` +
              `  3. Once phase 2 succeeds, run: cdkd state orphan ${resolvedStackName}\n` +
              `     to clean up cdkd's stale state record.`
          );
        }
      }

      // Delete cdkd state for the migrated stack. Done AFTER phase 2 so a
      // phase-2 failure leaves state intact for recovery (see catch above).
      // The lock is still held; we release it inside the outer `finally`.
      await stateBackend.deleteState(resolvedStackName, targetRegion);
      logger.info(
        `cdkd state for '${resolvedStackName}' (${targetRegion}) removed. ` +
          `Manage the stack with 'cdk deploy' or 'aws cloudformation' from here on.`
      );

      // Print the load-bearing handoff message: the exact cdk diff / cdk
      // deploy commands the user should run next, including any -c
      // overrides captured from this export run.
      printNextSteps({
        cfnStackName,
        cdkStackName: resolvedStackName,
        contextOverrides: options.context ?? [],
      });

      // observedProperties / etag / legacy migration are no longer
      // relevant since the state record is gone. The local references
      // are kept just to make it explicit that we deliberately discarded
      // them.
      void etag;
      void migrationPending;
    } finally {
      if (!options.dryRun) {
        await lockManager.releaseLock(resolvedStackName, targetRegion).catch((err) => {
          logger.warn(
            `Failed to release lock: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Decide which region's state to operate on. Mirrors the disambiguation
 * logic shared with `state resources` / `state show` / `orphan`.
 */
async function pickStackRegion(
  stateBackend: S3StateBackend,
  stackName: string,
  synthRegion: string | undefined,
  flag: string | undefined
): Promise<string> {
  const refs = (await stateBackend.listStacks()).filter((r) => r.stackName === stackName);
  if (refs.length === 0) {
    if (flag) return flag;
    if (synthRegion) return synthRegion;
    throw new Error(
      `No state found for stack '${stackName}'. Run 'cdkd state list' to see available stacks.`
    );
  }
  if (flag) {
    const found = refs.find((r) => r.region === flag);
    if (!found) {
      const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
      throw new Error(
        `No state found for stack '${stackName}' in region '${flag}'. Available regions: ${seen}.`
      );
    }
    return flag;
  }
  if (synthRegion) {
    const found = refs.find((r) => r.region === synthRegion);
    if (found) return synthRegion;
  }
  if (refs.length === 1) {
    return refs[0]!.region ?? synthRegion ?? '';
  }
  const regions = refs.map((r) => r.region ?? '(legacy)').join(', ');
  throw new Error(
    `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
      `Re-run with --stack-region <region> to disambiguate.`
  );
}

function parseTemplateFile(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read template file '${path}': ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Template file '${path}' is not valid JSON. cdkd export only supports ` +
        `JSON templates (CDK-generated). Cause: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Template file '${path}' is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function assertCfnStackAbsent(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string
): Promise<void> {
  try {
    const resp = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = resp.Stacks?.[0];
    if (!stack) return;
    // REVIEW_IN_PROGRESS comes from a failed CreateChangeSet IMPORT that
    // was never deleted; surfacing it lets the user clean up before retry.
    throw new Error(
      `CloudFormation stack '${stackName}' already exists ` +
        `(status: ${stack.StackStatus ?? 'unknown'}). cdkd export ` +
        `only creates new stacks via IMPORT — delete or rename the existing stack first, ` +
        `or pass --cfn-stack-name to choose a different name.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(msg)) {
      // Expected: stack does not exist, we can proceed.
      return;
    }
    throw err;
  }
}

interface BlockedResource {
  logicalId: string;
  resourceType: string;
  reason: string;
}

/**
 * A resource that the 2-phase flow will CREATE in phase 2 (not import in
 * phase 1). Currently only `Custom::*` qualifies — CFn cannot adopt
 * custom-resource state, so the only way to make CFn aware of them is to
 * have it CREATE the resource fresh (which re-invokes the backing Lambda's
 * onCreate handler).
 */
interface Phase2CreateEntry {
  logicalId: string;
  resourceType: string;
}

/**
 * Returns true when a resource type is non-importable BUT can be handled
 * by the phase-2 CREATE path. Today this is exactly `Custom::*` and the
 * untyped CDK form `AWS::CloudFormation::CustomResource` (both are
 * Lambda-backed Custom Resources whose backing Lambda is itself in the
 * same stack and gets imported in phase 1).
 *
 * `AWS::CloudFormation::Stack` (nested stacks) is intentionally NOT in
 * this set: CFn would CREATE a duplicate nested stack rather than adopt
 * the existing one, which would conflict with whatever the cdkd state
 * thought it owned. cdkd doesn't deploy nested stacks anyway.
 *
 * Exported for unit testing.
 */
export function isPhase2CreatableType(resourceType: string): boolean {
  return isCustomResourceType(resourceType);
}

/**
 * Build the import plan from cdkd state + the synthesized template.
 *
 * Classifies every template resource into one of:
 *   - `phase1Imports`: importable into the new CFn stack via the IMPORT
 *     changeset. Must have an entry in cdkd state with a non-empty
 *     `physicalId` and a resolvable primary identifier.
 *   - `phase2Creates`: non-importable but `isPhase2CreatableType` — CFn
 *     will CREATE these in the phase-2 UPDATE changeset. Currently only
 *     `Custom::*`.
 *   - `recreateBeforePhase2`: AWS does NOT support IMPORT for these types
 *     (`handlers: []` in the CFn schema) but DOES support normal CREATE.
 *     Skipped from phase 1; the AWS-side resource is deleted between
 *     phases so CFn's phase-2 CREATE doesn't collide. When the user
 *     passes `--no-recreate-import-unsupported`, these are moved to
 *     `blocked` instead.
 *   - `blocked`: anything else. A non-empty `blocked` aborts the run.
 */
async function buildImportPlan(
  state: StackState,
  template: Record<string, unknown>,
  cfnClient: AwsClients['cloudFormation'],
  options: { recreateImportUnsupported: boolean } = { recreateImportUnsupported: true }
): Promise<{
  phase1Imports: ImportPlanEntry[];
  phase2Creates: Phase2CreateEntry[];
  recreateBeforePhase2: RecreateBeforePhase2Entry[];
  blocked: BlockedResource[];
}> {
  const templateResources = template['Resources'];
  if (
    !templateResources ||
    typeof templateResources !== 'object' ||
    Array.isArray(templateResources)
  ) {
    throw new Error('Template has no Resources section.');
  }

  const phase1Imports: ImportPlanEntry[] = [];
  const phase2Creates: Phase2CreateEntry[] = [];
  const recreateBeforePhase2: RecreateBeforePhase2Entry[] = [];
  const blocked: BlockedResource[] = [];
  const identifierCache = new Map<string, PrimaryIdentifierCacheEntry>();

  for (const [logicalId, raw] of Object.entries(templateResources as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const resource = raw as { Type?: string };
    const resourceType = resource.Type ?? '';
    if (!resourceType) continue;

    if (resourceType === 'AWS::CDK::Metadata') {
      // CDK sentinel — silently dropped. Not a real AWS resource.
      continue;
    }

    if (isNeverImportableType(resourceType)) {
      if (isPhase2CreatableType(resourceType)) {
        // Custom::* — CFn will CREATE fresh in phase 2.
        phase2Creates.push({ logicalId, resourceType });
      } else {
        // Nested stacks etc. — hard block.
        blocked.push({
          logicalId,
          resourceType,
          reason: 'CloudFormation cannot import or recreate this resource type',
        });
      }
      continue;
    }

    const stateEntry: ResourceState | undefined = state.resources[logicalId];
    if (!stateEntry || !stateEntry.physicalId) {
      blocked.push({
        logicalId,
        resourceType,
        reason: 'no entry in cdkd state (resource is in template but was not deployed by cdkd)',
      });
      continue;
    }

    // IMPORT-unsupported but CFn-createable types (`AWS::ApiGatewayV2::Stage`).
    // Skip phase-1 IMPORT entirely; cdkd will delete the AWS-side resource
    // between phases so CFn's phase-2 CREATE doesn't collide. The opt-out
    // flag `--no-recreate-import-unsupported` blocks them instead.
    if (IMPORT_UNSUPPORTED_RECREATABLE_TYPES.has(resourceType)) {
      if (options.recreateImportUnsupported) {
        recreateBeforePhase2.push({
          logicalId,
          resourceType,
          physicalId: stateEntry.physicalId,
          properties: stateEntry.properties ?? {},
        });
      } else {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `AWS CloudFormation does not support ${resourceType} in IMPORT changesets ` +
            `(${resourceType} has no IMPORT handler). Re-run without ` +
            `--no-recreate-import-unsupported to let cdkd delete the AWS-side resource ` +
            `before phase 2 (CFn will then CREATE it fresh; brief unavailability window).`,
        });
      }
      continue;
    }

    let resolved: CompositeIdResult;
    try {
      resolved = await resolveResourceIdentifier(
        resourceType,
        stateEntry.physicalId,
        stateEntry.properties ?? {},
        cfnClient,
        identifierCache
      );
    } catch (err) {
      blocked.push({
        logicalId,
        resourceType,
        reason:
          'could not resolve resource identifier: ' +
          (err instanceof Error ? err.message : String(err)),
      });
      continue;
    }

    phase1Imports.push({
      logicalId,
      resourceType,
      physicalId: stateEntry.physicalId,
      resourceIdentifier: resolved.resourceIdentifier,
      propertiesOverlay: resolved.propertiesOverlay ?? resolved.resourceIdentifier,
    });
  }

  return { phase1Imports, phase2Creates, recreateBeforePhase2, blocked };
}

/**
 * Per-type cached `primaryIdentifier` field names from
 * `cloudformation:DescribeType`. The cache key is the resource type;
 * the value is the field-name list (length 1 for single-key types,
 * length > 1 for composites).
 */
type PrimaryIdentifierCacheEntry = { fields: string[] };

/**
 * Build the `ResourceIdentifier` map CloudFormation IMPORT expects in
 * `ResourcesToImport[].ResourceIdentifier` for the given resource type
 * and cdkd state's physical ID.
 *
 * Single-key types: the map has a single entry keyed by the schema's
 * primaryIdentifier field name (e.g. `{ BucketName: 'my-bucket' }`).
 *
 * Composite types (`primaryIdentifier.length > 1`): a per-type splitter
 * registered in `COMPOSITE_ID_SPLITTERS` parses cdkd's physicalId — whose
 * format is provider-defined, see `src/provisioning/providers/*.ts` —
 * into one entry per field. Composite types without a registered
 * splitter surface a clear error pointing at where to add one.
 *
 * Prefers `DescribeType` (the authoritative AWS-internal registry) and
 * falls back to a hardcoded single-key table when DescribeType fails
 * (insufficient permissions, throttling, obscure type without a registry
 * entry).
 */
async function resolveResourceIdentifier(
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown>,
  cfnClient: AwsClients['cloudFormation'],
  cache: Map<string, PrimaryIdentifierCacheEntry>
): Promise<CompositeIdResult> {
  let entry = cache.get(resourceType);
  if (entry === undefined) {
    entry = await fetchPrimaryIdentifier(resourceType, cfnClient);
    cache.set(resourceType, entry);
  }

  if (entry.fields.length === 1) {
    // Single-key path: the physicalId IS the identifier value.
    const map = { [entry.fields[0]!]: physicalId };
    return { resourceIdentifier: map };
  }

  // Composite path: consult the per-type splitter.
  const splitter = COMPOSITE_ID_SPLITTERS[resourceType];
  if (!splitter) {
    throw new Error(
      `resource type uses a composite primary identifier ` +
        `(${entry.fields.length} fields: ${entry.fields.join(', ')}); ` +
        `add an entry to COMPOSITE_ID_SPLITTERS in src/cli/commands/export.ts ` +
        `that parses cdkd's physicalId for this type, or destroy the resource ` +
        `first and let CFn create it fresh`
    );
  }

  let result: CompositeIdResult;
  try {
    result = splitter(physicalId, properties);
  } catch (err) {
    throw new Error(
      `composite-id splitter for ${resourceType} failed: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  // Sanity check: splitter must produce one resourceIdentifier entry per declared field.
  for (const f of entry.fields) {
    if (!(f in result.resourceIdentifier)) {
      throw new Error(
        `composite-id splitter for ${resourceType} did not produce field '${f}' ` +
          `(produced: ${Object.keys(result.resourceIdentifier).join(', ')})`
      );
    }
  }
  return result;
}

/**
 * Fetch the primary identifier field names for a resource type, with a
 * hardcoded single-key fallback when DescribeType is unavailable.
 */
async function fetchPrimaryIdentifier(
  resourceType: string,
  cfnClient: AwsClients['cloudFormation']
): Promise<PrimaryIdentifierCacheEntry> {
  try {
    const resp = await cfnClient.send(
      new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType })
    );
    if (resp.Schema) {
      const parsed = JSON.parse(resp.Schema) as { primaryIdentifier?: unknown };
      const primary = parsed.primaryIdentifier;
      if (
        Array.isArray(primary) &&
        primary.length > 0 &&
        primary.every((p) => typeof p === 'string')
      ) {
        // Schema entries look like "/properties/BucketName" — strip the
        // JSON-pointer prefix to get the property name.
        const fields = primary.map((p) => p.replace(/^\/properties\//, ''));
        return { fields };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().debug(`DescribeType failed for ${resourceType}: ${msg} — using fallback`);
  }

  const fallback = PRIMARY_IDENTIFIER_FALLBACK[resourceType];
  if (fallback) {
    return { fields: [fallback] };
  }
  throw new Error(
    `primary identifier unknown (DescribeType returned no usable schema and no fallback ` +
      `is registered). Add ${resourceType} to PRIMARY_IDENTIFIER_FALLBACK in ` +
      `export.ts, or open an issue.`
  );
}

/**
 * Strip the template down to only the resources we intend to import.
 *
 * CloudFormation `ChangeSetType=IMPORT` requires every resource in the
 * template to appear in `ResourcesToImport`; anything extra causes the
 * changeset to fail. Outputs that reference a removed resource are also
 * stripped to avoid Ref-to-nonexistent errors.
 */
/**
 * Parse `--parameter Key=Value` CLI tokens into a `{Key: Value}` map.
 * Exported for unit testing.
 */
export function parseParameterOverrides(tokens: string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!tokens) return map;
  for (const t of tokens) {
    const eq = t.indexOf('=');
    if (eq < 1) {
      throw new Error(
        `Invalid --parameter '${t}': expected 'Key=Value' (e.g. --parameter Env=prod)`
      );
    }
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1);
    if (!key) {
      throw new Error(`Invalid --parameter '${t}': key is empty`);
    }
    map[key] = value;
  }
  return map;
}

/**
 * Build the `Parameters` array CFn `CreateChangeSetCommand` expects from
 * the synthesized template's `Parameters` section, applying user
 * `--parameter Key=Value` overrides.
 *
 * Resolution order per parameter:
 *   1. User-supplied override (`--parameter Key=Value`)
 *   2. Template `Default`
 *   3. Abort: missing required parameter
 *
 * SSM-typed parameters (`AWS::SSM::Parameter::Value<...>`) are passed
 * through verbatim — CFn resolves the SSM path at changeset execution
 * time, so cdkd does not need to make an extra SSM API call.
 *
 * Exported for unit testing.
 */
export function resolveTemplateParameters(
  template: Record<string, unknown>,
  userOverrides: Record<string, string>
): { parameters: Parameter[]; missing: string[] } {
  const tplParams = template['Parameters'];
  if (!tplParams || typeof tplParams !== 'object' || Array.isArray(tplParams)) {
    // Template has no Parameters section — nothing to forward.
    const stray = Object.keys(userOverrides);
    if (stray.length > 0) {
      throw new Error(
        `--parameter override(s) supplied (${stray.join(', ')}) but template has no Parameters section.`
      );
    }
    return { parameters: [], missing: [] };
  }

  const parameters: Parameter[] = [];
  const missing: string[] = [];
  const known = new Set<string>();

  for (const [name, raw] of Object.entries(tplParams as Record<string, unknown>)) {
    known.add(name);
    const def = (raw ?? {}) as { Default?: unknown };
    const override = userOverrides[name];
    if (override !== undefined) {
      parameters.push({ ParameterKey: name, ParameterValue: override });
      continue;
    }
    if ('Default' in def) {
      // Coerce non-string defaults (numbers, lists) to the string form CFn expects.
      const value = typeof def.Default === 'string' ? def.Default : String(def.Default);
      parameters.push({ ParameterKey: name, ParameterValue: value });
      continue;
    }
    missing.push(name);
  }

  // Catch typos: a --parameter override for a parameter the template does NOT declare.
  for (const name of Object.keys(userOverrides)) {
    if (!known.has(name)) {
      throw new Error(
        `--parameter override '${name}' does not match any parameter in the synthesized template ` +
          `(template declares: ${[...known].join(', ') || '(none)'})`
      );
    }
  }

  return { parameters, missing };
}

/**
 * Mutates `template['Resources']` so every entry has a `DeletionPolicy`
 * attribute. Resources already carrying any `DeletionPolicy` value
 * (Delete / Retain / Snapshot) are untouched; resources missing the
 * attribute get `DeletionPolicy: Retain` injected.
 *
 * Required by CloudFormation `ChangeSetType=IMPORT`, which rejects the
 * changeset if any resource in the template lacks `DeletionPolicy`.
 * CDK-synth templates only emit the attribute when the user sets
 * `RemovalPolicy` explicitly, so most resources are missing it. We
 * inject `Retain` (rather than `Delete`) so an accidental
 * `aws cloudformation delete-stack` between export and the first
 * post-export `cdk deploy` cannot drop AWS resources. The first
 * `cdk deploy` resets each `DeletionPolicy` to the user's
 * CDK-declared value (or absent), so the injection is transient.
 *
 * `UpdateReplacePolicy` is intentionally NOT injected — only
 * `DeletionPolicy` is required for IMPORT, and minimizing the injected
 * surface keeps the post-export `cdk diff` as small as possible.
 *
 * Returns the number of resources that received an injection.
 *
 * Exported for unit testing.
 */
export function injectDeletionPolicyForImport(template: Record<string, unknown>): number {
  const resources = template['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return 0;
  }
  let injected = 0;
  for (const [, resource] of Object.entries(resources as Record<string, unknown>)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    if (r['DeletionPolicy'] === undefined) {
      r['DeletionPolicy'] = 'Retain';
      injected++;
    }
  }
  return injected;
}

export function filterTemplateForImport(
  template: Record<string, unknown>,
  plan: ImportPlanEntry[]
): Record<string, unknown> {
  const allow = new Map(plan.map((p) => [p.logicalId, p] as const));
  const original = template['Resources'] as Record<string, unknown>;
  const filteredResources: Record<string, unknown> = {};
  for (const [logicalId, resource] of Object.entries(original)) {
    const entry = allow.get(logicalId);
    if (!entry) continue;
    filteredResources[logicalId] = overlayResourceIdentifierOnProperties(resource, entry);
  }

  const result: Record<string, unknown> = { ...template, Resources: filteredResources };

  // CloudFormation IMPORT changesets do NOT allow Outputs — AWS rejects
  // the changeset with "As part of the import operation, you cannot
  // modify or add [Outputs]". This applies even to Outputs that only
  // reference imported resources. Strip them entirely here; phase 2
  // UPDATE re-submits the full synth template and restores Outputs
  // along with the non-importable resources.
  delete result['Outputs'];

  return result;
}

/**
 * Overlay each `ResourceIdentifier` field onto the resource's
 * `Properties` so that the template's identifier values match the
 * actual AWS physical id. Required by CloudFormation `ChangeSetType=
 * IMPORT`, which compares `ResourcesToImport[].ResourceIdentifier`
 * against the corresponding `Properties[<IdField>]` in the template
 * and rejects the import when they differ — see error: "The
 * Identifier [<Field>] for resource [...] does not match the
 * identifier value for the resource in the template."
 *
 * cdkd's deploy path prefixes user-declared physical names with the
 * stack name (`<StackName>-<UserDeclaredName>`) for cross-stack
 * uniqueness, so the synthesized template's `Properties.RoleName` /
 * `BucketName` / `TopicName` / etc. (the user-declared value) doesn't
 * match what cdkd stored as the resource's physicalId. The overlay
 * here uses the prefixed value cdkd built for the ResourceIdentifier,
 * keeping the IMPORT changeset internally consistent.
 *
 * **Replacement risk on next `cdk deploy`**: the overlay persists into
 * the post-import CFn-managed template. When the user later runs
 * `cdk deploy`, CDK synth re-emits the user-declared name (e.g.
 * `cdkd-export-test-…` without prefix). CFn sees `RoleName` change on
 * an immutable property and proposes REPLACEMENT — which destroys the
 * original AWS resource. This is the same caveat documented for
 * upstream `cdk import`; users should set explicit physical names in
 * CDK code that match cdkd's prefixed values before the first
 * post-export deploy, or run `cdk diff` to inspect.
 */
function overlayResourceIdentifierOnProperties(resource: unknown, entry: ImportPlanEntry): unknown {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    return resource;
  }
  const r = resource as Record<string, unknown>;
  const existingProperties = r['Properties'];
  const properties: Record<string, unknown> =
    existingProperties &&
    typeof existingProperties === 'object' &&
    !Array.isArray(existingProperties)
      ? { ...(existingProperties as Record<string, unknown>) }
      : {};
  // Use propertiesOverlay (subset of resourceIdentifier safe to write into
  // Properties) — not resourceIdentifier itself. Sub-resource types whose
  // primaryIdentifier includes a generated-id field (e.g.
  // AWS::ApiGatewayV2::Integration.IntegrationId) narrow overlay to just the
  // writable subset; CFn rejects unknown property keys at changeset-create.
  // When the entry has no explicit overlay map, fall back to the full
  // resourceIdentifier (matches pre-PR behavior for single-key types and
  // composites whose identifier fields ARE all valid Properties).
  const overlay = entry.propertiesOverlay ?? entry.resourceIdentifier;
  for (const [field, value] of Object.entries(overlay)) {
    properties[field] = value;
  }
  return { ...r, Properties: properties };
}

/**
 * Build the phase-2 UPDATE template: full synth template with cdkd's
 * `ResourceIdentifier` overlay applied to every phase-1 import. This keeps
 * the CFn-managed template's `Properties` consistent with what cdkd
 * imported in phase 1 — preventing CFn from seeing a "Name property
 * removed / changed" diff between the phase-1 IMPORT'd state (overlay
 * applied) and a raw phase-2 synth template (overlay absent), which would
 * trigger silent REPLACEMENT of every imported resource whose Name is an
 * immutable property (IAM Role, S3 Bucket, ECR Repository, Lambda
 * Function, etc.).
 *
 * **Why this matters** — discovered via real-AWS dogfooding 2026-05-12:
 * pre-fix `cdkd export` against cdk-sample's CdkSampleStack silently
 * REPLACED 24 resources during phase-2 `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`,
 * including the S3 Bucket and ECR Repository. cdk-sample's
 * `autoDeleteObjects: true` happened to mask the data-loss visibility,
 * but on a production stack this would have wiped the S3 contents and
 * ECR images.
 *
 * The overlay then persists into the final CFn-managed template. When
 * the user runs `cdk deploy` after the migration, CDK synth produces
 * the raw unprefixed Name → CFn proposes REPLACEMENT → the user decides
 * (accept the replace, update CDK code to use the cdkd-prefixed name,
 * or migrate data first). That deferred-to-cdk-deploy REPLACE is the
 * documented post-export caveat — same as upstream `cdk import` — and
 * it now happens with explicit user consent instead of silently during
 * the cdkd export operation itself.
 *
 * Resources outside `phase1Imports` (phase-2 CREATE Custom Resources,
 * pre-delete + recreate targets like Stage / IAM::Policy) are passed
 * through unchanged — they get CREATEd from synth and don't have any
 * pre-existing Properties state to preserve.
 *
 * Exported for unit testing.
 */
export function applyImportOverlayForPhase2(
  template: Record<string, unknown>,
  phase1Imports: ImportPlanEntry[]
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  const resources = result['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return result;
  }
  const resourcesMap = resources as Record<string, unknown>;
  for (const entry of phase1Imports) {
    const r = resourcesMap[entry.logicalId];
    if (r !== undefined) {
      resourcesMap[entry.logicalId] = overlayResourceIdentifierOnProperties(r, entry);
    }
  }
  return result;
}

/**
 * Returns true if every `Ref` / `Fn::GetAtt` inside `node` points at a
 * logical ID in `allow`. Used to keep Outputs entries that only reference
 * imported resources and drop the ones that referenced excluded ones.
 */
/**
 * Pre-flight check for missing drift baselines (`observedProperties`)
 * in the exporting stack's state. cdkd state schema v3 captures
 * `observedProperties` on every successful create / update / import so
 * `cdkd drift` has a reliable AWS-current baseline. Resources written
 * by an older binary OR by providers that do not implement
 * `readCurrentState` lack the field, and `cdkd drift` falls back to
 * comparing against the user's template intent (weaker signal).
 *
 * If we are about to migrate to CFn, the user has no way to roll back
 * post-migration — any drift between cdkd state and AWS reality would
 * surface as spurious changes on the first post-export `cdk deploy`.
 * Warn loudly so the user can run `cdkd state refresh-observed` and
 * `cdkd drift` first if they care. Non-blocking by design — exit is the
 * user's call, not the tool's.
 *
 * Exported for unit testing.
 */
export function reportDriftBaselineGaps(
  state: StackState,
  logger: ReturnType<typeof getLogger>
): void {
  const entries = Object.entries(state.resources ?? {});
  if (entries.length === 0) return;
  const missing = entries.filter(([, r]) => r.observedProperties === undefined);
  if (missing.length === 0) return;
  if (state.version !== undefined && state.version < 3) {
    logger.warn(
      `cdkd state schema is v${state.version} (pre-observedProperties). cdkd drift ` +
        `cannot reliably compare against AWS for this stack; the next \`cdk deploy\` ` +
        `after migration may surface spurious changes if AWS has drifted from the ` +
        `template. Run \`cdkd state refresh-observed ${state.stackName}\` (or any ` +
        `redeploy) before export to capture an AWS-current baseline.`
    );
    return;
  }
  logger.warn(
    `${missing.length} of ${entries.length} resource(s) in cdkd state lack an ` +
      `AWS-current baseline (observedProperties). cdkd drift may produce false positives ` +
      `for them; the next \`cdk deploy\` after migration may surface unexpected changes. ` +
      `Run \`cdkd state refresh-observed ${state.stackName}\` to capture a baseline before ` +
      `export, then \`cdkd drift\` to verify the stack matches AWS.`
  );
  for (const [logicalId] of missing.slice(0, 10)) {
    logger.warn(`  ${logicalId}`);
  }
  if (missing.length > 10) {
    logger.warn(`  ... and ${missing.length - 10} more`);
  }
}

/**
 * A `Fn::GetStackOutput` reference found in another stack's template,
 * pointing at the stack being exported. Produced by `scanCrossStackReferences`.
 */
export interface CrossStackReference {
  /** Logical ID of the stack that contains the reference. */
  consumerStackName: string;
  /** OutputName from the `Fn::GetStackOutput` call. */
  outputName: string;
  /** Where in the consumer template the reference appears (Resources / Outputs path). */
  location: string;
}

/**
 * Walk every stack other than `exportingStackName` looking for
 * `Fn::GetStackOutput` calls that target the exporting stack. Used as a
 * safety pre-flight before `cdkd export`: after the exporting stack
 * moves to CloudFormation, its outputs live in CFn (not cdkd state), so
 * cdkd's `Fn::GetStackOutput` resolver — which reads cdkd state — can
 * no longer find them.
 *
 * Implementation: recursive walk of each non-exporting stack's template,
 * collecting every `{"Fn::GetStackOutput": {StackName: <exporting>, OutputName: <name>}}`
 * entry. The intrinsic accepts either an object form
 * (`{StackName: ..., OutputName: ...}`) or — historically — an array
 * form (`[stackName, outputName]`); we accept both.
 *
 * Exported for unit testing.
 */
export function scanCrossStackReferences(
  stacks: Array<{ stackName: string; template: unknown }>,
  exportingStackName: string
): CrossStackReference[] {
  const refs: CrossStackReference[] = [];
  for (const stack of stacks) {
    if (stack.stackName === exportingStackName) continue;
    walkForGetStackOutput(stack.template, '', (ref) => {
      if (ref.stackName === exportingStackName) {
        refs.push({
          consumerStackName: stack.stackName,
          outputName: ref.outputName,
          location: ref.location,
        });
      }
    });
  }
  return refs;
}

function walkForGetStackOutput(
  node: unknown,
  path: string,
  emit: (ref: { stackName: string; outputName: string; location: string }) => void
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkForGetStackOutput(item, `${path}[${i}]`, emit));
    return;
  }
  const obj = node as Record<string, unknown>;
  const intrinsic = obj['Fn::GetStackOutput'];
  if (intrinsic !== undefined) {
    // Object form (current, documented): { StackName: "...", OutputName: "..." }.
    if (intrinsic && typeof intrinsic === 'object' && !Array.isArray(intrinsic)) {
      const i = intrinsic as Record<string, unknown>;
      const stackName = typeof i['StackName'] === 'string' ? i['StackName'] : undefined;
      const outputName = typeof i['OutputName'] === 'string' ? i['OutputName'] : undefined;
      if (stackName && outputName) {
        emit({ stackName, outputName, location: path });
      }
    } else if (Array.isArray(intrinsic) && intrinsic.length === 2) {
      // Defensive: legacy array form [stackName, outputName].
      const arr = intrinsic as unknown[];
      const stackName = arr[0];
      const outputName = arr[1];
      if (typeof stackName === 'string' && typeof outputName === 'string') {
        emit({ stackName, outputName, location: path });
      }
    }
    // Fall through: the intrinsic's value may contain other intrinsics
    // (e.g. Fn::Sub'd StackName). Walk into it so nested calls still surface.
  }
  for (const [key, value] of Object.entries(obj)) {
    walkForGetStackOutput(value, path ? `${path}.${key}` : key, emit);
  }
}

function printPlan(plan: ImportPlanEntry[], cfnStackName: string): void {
  const logger = getLogger();
  logger.info('');
  logger.info(`Import plan for CloudFormation stack '${cfnStackName}':`);
  for (const entry of plan) {
    const idStr = Object.entries(entry.resourceIdentifier)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    logger.info(`  ${entry.logicalId} (${entry.resourceType}) ← ${idStr}`);
  }
  logger.info('');
}

async function executeImportChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  plan: ImportPlanEntry[],
  parameters: Parameter[]
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-migrate-${Date.now()}`;
  const templateBody = JSON.stringify(template, null, 2);

  const resourcesToImport: ResourceToImport[] = plan.map((entry) => ({
    ResourceType: entry.resourceType,
    LogicalResourceId: entry.logicalId,
    ResourceIdentifier: entry.resourceIdentifier,
  }));

  logger.info(
    `Creating IMPORT changeset '${changeSetName}' for stack '${stackName}' ` +
      `(${plan.length} resource(s), ${templateBody.length} bytes)...`
  );

  // CFn IMPORT changesets accept TemplateBody up to 51,200 bytes inline.
  // Larger templates require S3 upload via TemplateURL. For MVP we only
  // support inline; larger payloads are deferred to a follow-up PR.
  if (templateBody.length > 51200) {
    throw new Error(
      `Filtered template is ${templateBody.length} bytes, over the 51,200-byte inline ` +
        `TemplateBody limit. Templates that large require TemplateURL upload (not yet ` +
        `implemented for cdkd export; please file an issue if you hit this).`
    );
  }

  try {
    await cfnClient.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: 'IMPORT',
        TemplateBody: templateBody,
        ResourcesToImport: resourcesToImport,
        ...(parameters.length > 0 && { Parameters: parameters }),
        // CDK templates routinely require CAPABILITY_IAM /
        // CAPABILITY_NAMED_IAM. Forward both so the user does not have to
        // re-discover and re-pass them.
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create IMPORT changeset: ${msg}`);
  }

  try {
    await waitUntilChangeSetCreateComplete(
      { client: cfnClient, maxWaitTime: 600 },
      { StackName: stackName, ChangeSetName: changeSetName }
    );
  } catch (err) {
    // CreateChangeSet returns FAILED with a StatusReason on validation
    // problems (template error, identifier mismatch, etc.). Fetch the
    // reason and surface it before re-throwing.
    try {
      const desc = await cfnClient.send(
        new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
      );
      const reason = desc.StatusReason ?? 'unknown';
      // Clean up the failed changeset so the next attempt is not blocked
      // by a REVIEW_IN_PROGRESS phantom stack.
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      throw new Error(`IMPORT changeset FAILED: ${reason}`);
    } catch (innerErr) {
      if (innerErr instanceof Error && innerErr.message.startsWith('IMPORT changeset FAILED')) {
        throw innerErr;
      }
      throw err;
    }
  }

  // Execute + wait must clean up the changeset on failure too: if the
  // import errors after CreateChangeSet succeeded, the changeset sticks
  // around and a subsequent run hits `assertCfnStackAbsent`'s "stack
  // already exists" path (CFn parks the stack in REVIEW_IN_PROGRESS).
  // We delete the changeset best-effort and let the original error
  // propagate.
  logger.info(`Executing IMPORT changeset...`);
  try {
    await cfnClient.send(
      new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
    );
    await waitUntilStackImportComplete(
      { client: cfnClient, maxWaitTime: 3600 },
      { StackName: stackName }
    );
  } catch (err) {
    // On IMPORT failure, fetch the per-resource failure reasons from
    // CFn stack events so the user can see WHICH resource failed and
    // WHY. The waiter only reports the high-level rollback state.
    const failureSummary = await collectImportFailureSummary(cfnClient, stackName).catch(() => '');
    await cfnClient
      .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
      .catch(() => {});
    if (failureSummary) {
      throw new Error(`IMPORT changeset failed:\n${failureSummary}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Fetch the most recent CFn stack events and extract the per-resource
 * failure reasons. Surfaced when `waitUntilStackImportComplete`'s waiter
 * reports FAILURE — the waiter itself only reports the high-level
 * rollback state, so the actionable detail is in the events.
 *
 * Returns up to 5 distinct failed resources, formatted as
 * `<LogicalId> (<Type>): <ResourceStatusReason>` per line. Returns an
 * empty string when DescribeStackEvents itself fails or no failure
 * events are found.
 */
async function collectImportFailureSummary(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string
): Promise<string> {
  const resp = await cfnClient.send(new DescribeStackEventsCommand({ StackName: stackName }));
  const events = resp.StackEvents ?? [];
  // Walk events newest-first (CFn returns them in reverse chronological
  // order) and collect distinct per-resource failure entries.
  const failures: { logicalId: string; type: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.ResourceStatus || !e.ResourceStatus.endsWith('FAILED')) continue;
    if (!e.LogicalResourceId) continue;
    if (seen.has(e.LogicalResourceId)) continue;
    seen.add(e.LogicalResourceId);
    failures.push({
      logicalId: e.LogicalResourceId,
      type: e.ResourceType ?? '<unknown>',
      reason: e.ResourceStatusReason ?? '<no reason reported>',
    });
    if (failures.length >= 5) break;
  }
  if (failures.length === 0) return '';
  return failures.map((f) => `  - ${f.logicalId} (${f.type}): ${f.reason}`).join('\n');
}

/**
 * Phase 2 of the 2-phase migration: a CFn UPDATE changeset that ADDs the
 * non-importable resources (`Custom::*`) to the just-created stack. CFn
 * diffs against the phase-1 stack state, sees the new resources, and
 * CREATEs them — which invokes each Custom Resource's backing Lambda
 * onCreate handler.
 *
 * Failure semantics: caller catches and surfaces a clear recovery path
 * (cdkd state is intentionally NOT deleted between phases, so a phase-2
 * failure leaves a recoverable state).
 */
async function executeUpdateChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  parameters: Parameter[]
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-phase2-${Date.now()}`;
  const templateBody = JSON.stringify(template, null, 2);

  if (templateBody.length > 51200) {
    throw new Error(
      `Full template is ${templateBody.length} bytes, over the 51,200-byte inline ` +
        `TemplateBody limit for phase-2 UPDATE. TemplateURL upload is not yet implemented.`
    );
  }

  logger.info(
    `Creating UPDATE changeset '${changeSetName}' for phase 2 ` +
      `(${templateBody.length} bytes)...`
  );

  try {
    await cfnClient.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: 'UPDATE',
        TemplateBody: templateBody,
        ...(parameters.length > 0 && { Parameters: parameters }),
        Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create UPDATE changeset: ${msg}`);
  }

  try {
    await waitUntilChangeSetCreateComplete(
      { client: cfnClient, maxWaitTime: 600 },
      { StackName: stackName, ChangeSetName: changeSetName }
    );
  } catch (err) {
    try {
      const desc = await cfnClient.send(
        new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
      );
      const reason = desc.StatusReason ?? 'unknown';
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      throw new Error(`UPDATE changeset FAILED: ${reason}`);
    } catch (innerErr) {
      if (innerErr instanceof Error && innerErr.message.startsWith('UPDATE changeset FAILED')) {
        throw innerErr;
      }
      throw err;
    }
  }

  logger.info(`Executing UPDATE changeset...`);
  try {
    await cfnClient.send(
      new ExecuteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName })
    );
    await waitUntilStackUpdateComplete(
      { client: cfnClient, maxWaitTime: 3600 },
      { StackName: stackName }
    );
  } catch (err) {
    await cfnClient
      .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
      .catch(() => {});
    throw err;
  }
}

/**
 * Refuse to proceed when the user passed CLI `-c key=value` overrides
 * without `--accept-transient-context`. The CLI form is not persisted
 * to `cdk.json` / `cdk.context.json`, so a subsequent `cdk deploy`
 * invoked without the same `-c` flags will synthesize a different
 * template — and CFn will see drift / replace resources on first
 * post-migration deploy.
 *
 * The escape hatch (`--accept-transient-context`) is intentionally
 * loud at runtime: a warn is emitted that names every override and
 * tells the user to keep them around for future `cdk deploy` runs.
 *
 * Exported for unit testing.
 */
export function refuseTransientContextIfUnsafe(options: {
  context?: string[];
  acceptTransientContext: boolean;
}): void {
  const overrides = options.context ?? [];
  if (overrides.length === 0) return;

  if (!options.acceptTransientContext) {
    const indented = overrides.map((v) => `    -c ${v}`).join('\n');
    throw new Error(
      `Refusing to export: ${overrides.length} CLI context override(s) supplied via -c are ` +
        `not persisted to cdk.json / cdk.context.json, so subsequent \`cdk deploy\` ` +
        `invocations will synthesize a different template and CFn will see drift or ` +
        `replace resources.\n\n` +
        `Supplied:\n${indented}\n\n` +
        `Choose one:\n` +
        `  (recommended) Move these values into cdk.json's "context": { ... } field, then re-run\n` +
        `                cdkd export without -c. CDK CLI reads cdk.json on every synth, so they\n` +
        `                will be picked up automatically.\n` +
        `  (escape)      Pass --accept-transient-context to proceed. You will then need to\n` +
        `                pass the SAME -c flags to every future \`cdk deploy\` for this stack.`
    );
  }

  const logger = getLogger();
  logger.warn(
    `--accept-transient-context: ${overrides.length} CLI context override(s) will not be ` +
      `persisted to cdk.json / cdk.context.json. Remember to pass the same -c flags to every ` +
      `future \`cdk deploy\` for this stack, or move them to cdk.json before then.`
  );
  for (const v of overrides) {
    logger.warn(`  -c ${v}`);
  }
}

/**
 * Print a final "next steps" block listing the exact `cdk deploy` /
 * `cdk diff` commands the user should run to verify the migration and
 * to manage the stack going forward. Always emitted on successful
 * export — this is the load-bearing "handoff" message that lets a user
 * who runs `cdkd export` once a year find their way without consulting
 * the docs.
 *
 * When CLI `-c` overrides were used (with `--accept-transient-context`),
 * the printed `cdk deploy` and `cdk diff` commands include them, so a
 * copy-paste keeps the synth deterministic.
 */
function printNextSteps(args: {
  cfnStackName: string;
  cdkStackName: string;
  contextOverrides: string[];
}): void {
  const logger = getLogger();
  const ctxArgs = args.contextOverrides.map((v) => ` -c ${v}`).join('');
  const stackId = args.cdkStackName;
  logger.info('');
  logger.info('Next steps — manage the stack with CDK CLI from now on:');
  logger.info(`  cdk diff ${stackId}${ctxArgs}    # verify synth matches what CFn now holds`);
  logger.info(`  cdk deploy ${stackId}${ctxArgs}  # subsequent updates`);
  if (args.contextOverrides.length > 0) {
    logger.info('');
    logger.info(
      '  NOTE: the -c flags above were captured from this export run. They MUST be ' +
        'passed on every future cdk invocation, or moved into cdk.json\'s "context" field.'
    );
  }
  logger.info('');
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

export function createExportCommand(): Command {
  const cmd = new Command('export')
    .description(
      'Hand a cdkd-managed stack over to CloudFormation via CFn IMPORT (changeset). ' +
        'AWS resources are unchanged; cdkd state for the stack is deleted on success. ' +
        'Mirror of `cdkd import` (AWS → cdkd) in the reverse direction (cdkd → CFn). ' +
        'JSON templates only. Aborts if any resource is not CFn-importable.'
    )
    .argument('[stack]', 'Stack name to export (auto-detected for single-stack apps)')
    .option(
      '--cfn-stack-name <name>',
      'Name of the destination CloudFormation stack. Defaults to the cdkd stack name.'
    )
    .option(
      '--template <path>',
      'Path to a pre-rendered CloudFormation template (JSON). Skips synth.'
    )
    .option(
      '--stack-region <region>',
      'Region of the cdkd state record to operate on. Required when the same stack name has state in multiple regions.'
    )
    .option('--dry-run', 'Print the import plan without creating a changeset.', false)
    .option(
      '--accept-transient-context',
      'Allow CLI -c key=value overrides at export time even though they are not ' +
        'persisted to cdk.json / cdk.context.json (default: refuse). When set, the ' +
        'user is responsible for passing the same -c flags to every future cdk deploy.',
      false
    )
    .option(
      '--include-non-importable',
      'Run a 2-phase migration when the stack contains non-importable resources ' +
        '(Custom::*). Phase 1 imports the importable resources; phase 2 CFn-CREATEs ' +
        "the non-importable ones, which re-invokes each Custom Resource's onCreate " +
        'handler. Make sure onCreate is idempotent before enabling.',
      false
    )
    .option(
      '--parameter <key=value...>',
      'CFn template Parameter override, repeatable. Required when the synthesized ' +
        'template has Parameters without Default values; otherwise overrides the ' +
        "template's default value. Format: --parameter Key=Value."
    )
    .option(
      '--strict-cross-stack',
      'Refuse to export when sibling cdkd stacks in the same CDK app reference the ' +
        'exporting stack via Fn::GetStackOutput. Without the flag, cdkd warns but ' +
        'proceeds — the user is expected to migrate the consumer stacks in a follow-up.',
      false
    )
    .option(
      '--no-recreate-import-unsupported',
      'Block instead of auto-handling resource types AWS does NOT support in IMPORT ' +
        'changesets (currently only AWS::ApiGatewayV2::Stage, emitted by CDK HttpApi). ' +
        'Default behavior: cdkd skips these from phase 1, deletes the AWS-side resource ' +
        'between phases, and lets CFn re-CREATE in phase 2 (brief unavailability window). ' +
        'With this flag, the export aborts with a clear error instead.'
    )
    .action(withErrorHandling(exportCommand));

  [...commonOptions, ...appOptions, ...stateOptions, ...contextOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
