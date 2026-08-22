import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  ExecuteChangeSetCommand,
  DescribeStacksCommand,
  DeleteChangeSetCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  waitUntilChangeSetCreateComplete,
  waitUntilStackImportComplete,
  waitUntilStackUpdateComplete,
  type ResourceToImport,
  type Parameter,
  type Tag as CfnTag,
} from '@aws-sdk/client-cloudformation';
import {
  DescribeSecurityGroupRulesCommand,
  type DescribeSecurityGroupRulesResult,
  type EC2Client,
  type SecurityGroupRule,
} from '@aws-sdk/client-ec2';
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
import { canonicalizeIpProtocolValue } from '../../utils/ip-protocol.js';
import { describeTypeWithThrottleRetry } from '../../provisioning/describe-type.js';
import { withRetry } from '../../deployment/retry.js';
import { isThrottlingError } from '../../deployment/retryable-errors.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { foldRegionOption, namedCliRegion } from '../region-options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, synthesisStatusMessage } from '../../synthesis/synthesizer.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../deployment/intrinsic-function-resolver.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveApp, resolveStateBucketWithDefault } from '../config-loader.js';
import {
  CFN_TEMPLATE_BODY_LIMIT,
  CFN_TEMPLATE_URL_LIMIT,
  findLargeInlineResources,
  uploadCfnTemplate,
  type CfnUploadS3ClientOpts,
} from '../upload-cfn-template.js';
import { NESTED_STACK_RESOURCE_TYPE } from './retire-cfn-stack.js';
import type { ResourceState, StackState } from '../../types/state.js';
import {
  parseCfnTemplateWithFormat,
  stringifyCfnTemplate,
  type TemplateFormat,
} from '../yaml-cfn.js';

interface ExportOptions {
  app?: string;
  output?: string;
  template?: string;
  cfnStackName?: string;
  /**
   * Per-nested-child CFn stack-name override. Each entry is
   * `<cdkdStackName>=<cfnStackName>`. The cdkd stack name for a nested
   * child is `<parent>~<childLogicalId>` (v6 state-key form). Without an
   * override, cdkd derives the CFn stack name via {@link cdkd2cfnStackName}
   * (replaces `~` with `-` since CFn stack names reject `~`). Repeatable.
   * See issue #464 design §9 Q8 for the rationale.
   *
   * Only consulted when the exported stack tree contains nested children;
   * for flat stacks the flag is ignored.
   */
  cfnChildStackName?: string[];
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
  /**
   * Skip the registry-derived IMPORT-support pre-flight (issue
   * [#1659](https://github.com/go-to-k/cdkd/issues/1659)).
   *
   * The pre-flight refuses a type whose schema declares no `read` handler AND
   * reports `ProvisioningType: NON_PROVISIONABLE`. That is a HEURISTIC over the
   * registry, not AWS's actual supported-for-import list — it matched every
   * type measured (2026-08-13), but a type AWS later makes importable would be
   * hard-blocked by cdkd on an export that CloudFormation would accept, with
   * `blocked` aborting the whole run. The sibling
   * `IMPORT_UNSUPPORTED_RECREATABLE_TYPES` refusal has
   * `--no-recreate-import-unsupported`; this is its counterpart, so a wrong
   * heuristic costs a flag rather than a cdkd release.
   */
  skipImportSupportPreflight: boolean;
}

/**
 * Resource types that are known to be incompatible with CloudFormation
 * `ChangeSetType=IMPORT`:
 *
 *   - `AWS::CDK::Metadata` is a CDK sentinel; not a real AWS resource and
 *     CFn refuses to import it.
 *   - `AWS::CloudFormation::CustomResource` is the CFn resource type CDK
 *     emits for `new cdk.CustomResource(...)` when no `resourceType` is
 *     passed. Functionally identical to `Custom::*` — Lambda-backed,
 *     no AWS resource state to adopt — and AWS rejects it from IMPORT
 *     changesets with the same error.
 *   - `Custom::*` are Lambda-backed Custom Resources. CFn cannot adopt the
 *     custom-resource state — invocation history lives in the provider
 *     Lambda, not in AWS resource state, so there is nothing to import.
 *
 * `AWS::CloudFormation::Stack` is **intentionally NOT in this set** — it is
 * handled by a dedicated branch in {@link buildImportPlan} that routes the
 * row through the nested-stack tree walker (issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1). The CFn-side
 * `--include-nested-stacks` IMPORT changeset submission is tracked under
 * PR B2 — until that lands, the orchestrator hard-errors at submission
 * time with a clear pointer.
 *
 * The list is intentionally narrow, and stays hand-written because each member
 * is a cdkd / CDK construct rather than something the registry describes.
 *
 * It is NOT the only refusal, though — the "defer to the CreateChangeSet
 * error" note this comment used to end on was revisited in issue
 * [#1659](https://github.com/go-to-k/cdkd/issues/1659). Types AWS refuses for
 * IMPORT because their registry schema declares no `read` handler are now
 * caught by {@link buildImportPlan}'s pre-flight instead, which needs no
 * hand-maintained list (the signal is derived from the schema cdkd already
 * fetches for the identifier) and names every offender in one pass — AWS's own
 * error names only some of them.
 */
const NEVER_IMPORTABLE_TYPES = new Set<string>(['AWS::CDK::Metadata']);

/**
 * Per-non-root-child lock-acquisition retry budget for the nested-stack
 * export loop (`runPerStackImportLoop`). `acquireLockWithRetry` retries
 * `maxRetries` times with `retryDelay` between attempts, so the total wait
 * ceiling is `maxRetries * retryDelay` ≈ 30s. A genuinely-active concurrent
 * cdkd run on a child is awaited briefly instead of failing instantly;
 * `acquireLock`'s own expired-lock auto-cleanup (30-min TTL) covers the
 * crashed-previous-run case. 30s keeps an interactive `cdkd export` snappy
 * even across a multi-level tree (each child waits at most this ceiling).
 */
const CHILD_LOCK_RETRY_MAX_ATTEMPTS = 6;
const CHILD_LOCK_RETRY_DELAY_MS = 5000;

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
 *   `resourceIdentifier` map — correct for `AWS::ApiGateway::Method`, which
 *   has NO `readOnlyProperties` at all (live `DescribeType`, us-east-1,
 *   2026-08-12) — and for `AWS::ApiGateway::Stage` / `AWS::ApiGateway::Model`,
 *   which likewise declare none.
 *   Sub-resource types whose
 *   primaryIdentifier includes a generated-id field (`ResourceId` /
 *   `IntegrationId` / `RouteId` / Lambda::Permission's `Id`) MUST narrow to just the writable
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
 * `AWS::ApiGateway::Deployment` stores a bare `deploymentId` — or, on the
 * Cloud Control route, `deploymentId|restApiId` — while CFn primaryIdentifier
 * is `[DeploymentId, RestApiId]`), the splitter reorders explicitly. A field
 * CFn declares but cdkd never stores (`AWS::EC2::VPCGatewayAttachment`'s
 * read-only `AttachmentType`) is DERIVED from the recorded properties.
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
  // cdkd's SDK provider stores the BARE `resourceId` — `createResource`
  // returns `response.id` and every other method treats the physicalId as a
  // bare id, reading the parent `RestApiId` from the recorded properties. The
  // The Cloud Control path produces `restApiId|resourceId` (CC joins a
  // multi-part primaryIdentifier with `|`). That path is LIVE, not
  // historical: the #614 silent-drop rule still auto-routes these types
  // through Cloud Control, so both shapes exist in state in the wild and BOTH
  // are accepted here. Requiring the composite made
  // `cdkd export` throw on every SDK-created Resource — on a value cdkd
  // itself wrote (issue #1663).
  //
  // CFn primary identifier is [RestApiId, ResourceId], but unlike
  // AWS::ApiGateway::Method (which has NO read-only properties, verified live
  // us-east-1 2026-08-12) `ResourceId` is `readOnlyProperties` here — so it is
  // EXCLUDED from propertiesOverlay. Same narrowing, same reason, as the
  // ApiGatewayV2::Integration splitter below.
  //
  // This is defense-in-depth rather than a live bug fix:
  // `overlayResourceIdentifierOnProperties` writes a field ONLY when the
  // template already carries it as a literal string, and a synthesized
  // AWS::ApiGateway::Resource has RestApiId / ParentId / PathPart and no
  // ResourceId — so the default overlay would have skipped it anyway. Narrow
  // it explicitly so the safety does not depend on that conditional.
  'AWS::ApiGateway::Resource': (physicalId, properties) => {
    // `.trim()`, not truthiness: a blank id is as unusable as an empty one
    // and would otherwise ship `ResourceId: ' '` into the changeset.
    if (!physicalId.trim()) {
      throw new Error('empty physical id for AWS::ApiGateway::Resource (expected a resourceId)');
    }
    const parts = physicalId.split('|');
    if (parts.length > 2) {
      throw new Error(
        `expected a bare resourceId or 'restApiId|resourceId', got ${parts.length} parts: '${physicalId}'`
      );
    }
    if (parts.length === 2) {
      const [restApiId, resourceId] = parts as [string, string];
      if (!restApiId || !resourceId) {
        throw new Error(`empty part in 'restApiId|resourceId': '${physicalId}'`);
      }
      return {
        resourceIdentifier: { RestApiId: restApiId, ResourceId: resourceId },
        propertiesOverlay: { RestApiId: restApiId },
      };
    }
    const restApiId = readStringProperty(properties, 'RestApiId', 'AWS::ApiGateway::Resource');
    return {
      resourceIdentifier: { RestApiId: restApiId, ResourceId: physicalId },
      propertiesOverlay: { RestApiId: restApiId },
    };
  },
  // cdkd's SDK provider stores `<gatewayId>|<vpcId>` (ec2-provider.ts's
  // `createVpcGatewayAttachment`); the Cloud Control path — reached whenever
  // the template trips the #614 silent-drop rule, e.g. by declaring
  // `VpnGatewayId`, which the SDK provider does not handle — stores the CFn
  // primaryIdentifier joined, i.e. `<AttachmentType>|<vpcId>`. Both shapes
  // exist in state in the wild, so both are accepted.
  //
  // CFn primary identifier is [AttachmentType, VpcId] (live `DescribeType`,
  // us-east-1, 2026-08-12) — NOT the [VpcId, InternetGatewayId] this entry
  // claimed before issue #1691, which made `resolveCompositeId`'s field check
  // throw and aborted `cdkd export` on every stack with a VPC + IGW.
  // `AttachmentType` is `readOnlyProperties`, so the overlay narrows to
  // `VpcId` — same narrowing, same reason, as the ApiGatewayV2::Integration
  // splitter below.
  'AWS::EC2::VPCGatewayAttachment': (physicalId, properties) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<gatewayId>|<vpcId>' or '<AttachmentType>|<vpcId>'), ` +
          `got ${parts.length}: '${physicalId}'`
      );
    }
    const [first, vpcId] = parts as [string, string];
    if (!first || !vpcId) {
      throw new Error(`empty part in composite physical id: '${physicalId}'`);
    }
    return {
      resourceIdentifier: {
        AttachmentType: resolveGatewayAttachmentType(first, properties),
        VpcId: vpcId,
      },
      propertiesOverlay: { VpcId: vpcId },
    };
  },
  // No SDK provider registers `AWS::EC2::VPCCidrBlock`, so it is always
  // Cloud-Control-routed and cdkd's physicalId is the CC primaryIdentifier
  // joined with `|` in schema order: `<Id>|<VpcId>`. CFn primary identifier is
  // [Id, VpcId] and `Id` is `readOnlyProperties` (live `DescribeType`,
  // us-east-1, 2026-08-13), so the overlay narrows to `VpcId` — same
  // narrowing, same reason, as the `AWS::EC2::VPCGatewayAttachment` entry
  // above and the `AWS::EC2::Route` entry below.
  //
  // The two segments ARE discriminable by shape and this splitter binds them,
  // the way the `AWS::EC2::EIP` entry below binds `eipalloc-` — the association
  // id carries the distinct `vpc-cidr-assoc-` prefix while the VPC id does not.
  // BOTH sides are checked, for the same reason the EIP entry gives: validating
  // one side only is not a discriminator. A swapped pair would otherwise ship a
  // `ResourceIdentifier` naming a different resource and fail opaquely at
  // changeset-create.
  //
  // The BARE `<Id>` form is accepted too, and is not hypothetical: CloudFormation
  // reports an `AWS::EC2::VPCCidrBlock`'s `PhysicalResourceId` as the association
  // id alone, so a stack adopted via `cdkd import --migrate-from-cloudformation`
  // carries that shape in state. `VpcId` is then recovered from the recorded
  // properties, exactly as the `AWS::ApiGateway::Resource` entry above recovers
  // `RestApiId`.
  //
  // Without this entry the type's mere PRESENCE aborted the whole
  // `cdkd export` command — and any VPC carrying a secondary IPv4 CIDR or an
  // Amazon-provided IPv6 CIDR declares one, including every CDK `Vpc`
  // configured with `ipProtocol: IpProtocol.DUAL_STACK` (issue #1788).
  'AWS::EC2::VPCCidrBlock': (physicalId, properties) => {
    // `.trim()`, not truthiness — a blank segment is as unusable as an empty
    // one and would otherwise ship `Id: ' '`. Same guard, same reason, as the
    // `AWS::EC2::Route` and `AWS::ApiGateway::Resource` entries.
    if (!physicalId.trim()) {
      throw new Error('empty physical id for AWS::EC2::VPCCidrBlock (expected an association id)');
    }
    const parts = physicalId.split('|').map((p) => p.trim());
    if (parts.length > 2) {
      throw new Error(
        `expected a bare '<Id>' or '<Id>|<VpcId>', got ${parts.length} parts: '${physicalId}'`
      );
    }
    const id = parts[0]!;
    if (!id) {
      throw new Error(`empty part in '<Id>|<VpcId>': '${physicalId}'`);
    }
    if (!id.startsWith(VPC_CIDR_ASSOCIATION_ID_PREFIX)) {
      throw new Error(
        `'${physicalId}' does not start with an association id: CloudFormation identifies an ` +
          `AWS::EC2::VPCCidrBlock by [Id, VpcId], so the first segment must be a ` +
          `'${VPC_CIDR_ASSOCIATION_ID_PREFIX}…' id. State entry may be corrupt, or the segments ` +
          `may be reversed; re-deploy the resource to refresh state`
      );
    }
    let vpcId: string;
    if (parts.length === 2) {
      vpcId = parts[1]!;
      // Only reachable on THIS branch — `readStringProperty` already refuses an
      // empty / non-string recorded value on the bare-id branch below.
      if (!vpcId) {
        throw new Error(`empty part in '<Id>|<VpcId>': '${physicalId}'`);
      }
    } else {
      vpcId = readStringProperty(properties, 'VpcId', 'AWS::EC2::VPCCidrBlock');
    }
    // The VPC id must NOT itself be an association id — `vpc-cidr-assoc-a|vpc-cidr-assoc-b`
    // satisfies the first-segment guard above and then ships a `VpcId` naming
    // nothing. Checking one side only is not a discriminator.
    if (!VPC_ID_PATTERN.test(vpcId)) {
      throw new Error(
        `'${vpcId}' is not a VPC id (expected 'vpc-…', not an association id): ` +
          `'${physicalId}' may have its segments reversed`
      );
    }
    return {
      resourceIdentifier: { Id: id, VpcId: vpcId },
      propertiesOverlay: { VpcId: vpcId },
    };
  },
  // cdkd's SDK provider stores `<routeTableId>|<destination>` (ec2-provider.ts's
  // `createRoute`), where `destination` is whichever of `DestinationCidrBlock` /
  // `DestinationIpv6CidrBlock` / `DestinationPrefixListId` the route declares —
  // `narrowRouteDestinations` resolves them in that precedence order. The Cloud
  // Control path (reached when the template trips the #614 silent-drop rule)
  // stores the CFn primaryIdentifier joined, which is the SAME
  // `<RouteTableId>|<CidrBlock>` string, so both shapes coincide here and no
  // second form has to be accepted.
  //
  // CFn primary identifier is [RouteTableId, CidrBlock] with `CidrBlock`
  // `readOnlyProperties` (live `DescribeType`, us-east-1, 2026-08-13), so the
  // overlay narrows to `RouteTableId` — same narrowing, same reason, as the
  // `AWS::EC2::VPCGatewayAttachment` entry above.
  //
  // The one subtlety is what `CidrBlock` HOLDS. It is a single read-only field
  // and the schema gives it an empty description, so "the identifier is the
  // IPv4 CIDR" is the natural (and wrong) reading. Measured live instead —
  // Cloud Control `GetResource` against a scratch route table carrying both
  // destination shapes, us-east-1, 2026-08-13:
  //
  //   `rtb-…|0.0.0.0/0`   -> {"CidrBlock":"0.0.0.0/0","DestinationCidrBlock":"0.0.0.0/0",…}
  //   `rtb-…|::/0`        -> {"CidrBlock":"::/0","DestinationIpv6CidrBlock":"::/0",…}
  //   `rtb-…|pl-63a5400a` -> {"CidrBlock":"pl-63a5400a","DestinationPrefixListId":"pl-63a5400a",…}
  //
  // — i.e. `CidrBlock` carries whichever destination the route declares, so the
  // physicalId's destination segment maps onto it verbatim and this splitter
  // needs no per-destination-key branch. The recorded properties are still read
  // (see {@link resolveRouteDestination}) because the id and the properties can
  // legitimately diverge on the Cloud Control path, and surfacing that beats an
  // opaque CFn IMPORT rejection (issue #1771).
  'AWS::EC2::Route': (physicalId, properties) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<routeTableId>|<destination>'), got ${parts.length}: '${physicalId}'`
      );
    }
    const [routeTableId, destination] = parts as [string, string];
    // `.trim()`, not truthiness: `'  |  '` is two non-empty segments by
    // truthiness and would ship `RouteTableId: '  '` into the changeset.
    if (!routeTableId.trim() || !destination.trim()) {
      throw new Error(`empty part in '<routeTableId>|<destination>': '${physicalId}'`);
    }
    return {
      resourceIdentifier: {
        RouteTableId: routeTableId,
        CidrBlock: resolveRouteDestination(destination, properties),
      },
      propertiesOverlay: { RouteTableId: routeTableId },
    };
  },
  // cdkd's SDK provider stores `<publicIp>|<allocationId>` (ec2-provider.ts's
  // `eipPhysicalId`), deliberately the same shape the Cloud Control fallback
  // produced — and `verifyExplicit` normalizes an imported EIP to it too, so
  // every state record written by a create OR an import carries both segments.
  //
  // CFn primary identifier is [PublicIp, AllocationId] — same order — and BOTH
  // fields are `readOnlyProperties` (live `DescribeType`, us-east-1,
  // 2026-08-13; the type declares no `required` properties at all). So nothing
  // may be overlaid onto the synth template's `Properties`: the overlay is an
  // explicit empty map, exactly as `COMPOSITE_PHYSICAL_ID_IDENTIFIERS`'
  // all-read-only entries do, rather than relying on the overlay site's
  // "only writes a field the template already carries" conditional.
  //
  // A bare segment (`eipalloc-…` or a lone public IP) is tolerated by the
  // provider's own `parseEipPhysicalId`, but it cannot produce BOTH identifier
  // fields, so it is refused here with a re-deploy hint rather than sent to CFn
  // half-filled (CFn rejects a partial identifier).
  'AWS::EC2::EIP': (physicalId) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<publicIp>|<allocationId>'), got ${parts.length}: '${physicalId}'. ` +
          `CloudFormation identifies an AWS::EC2::EIP by BOTH fields, and neither can be ` +
          `recovered from the other; re-deploy the resource to refresh state`
      );
    }
    const [first, second] = parts as [string, string];
    if (!first.trim() || !second.trim()) {
      throw new Error(`empty part in '<publicIp>|<allocationId>': '${physicalId}'`);
    }
    // Bind by SHAPE, not by position. `eipPhysicalId` writes publicIp first and
    // every writer goes through it, but that ordering is the ONE thing here
    // nobody has verified against a state record in the wild — and a positional
    // bind turns a reversed record into `{PublicIp: 'eipalloc-…',
    // AllocationId: '52.1.2.3'}`, which CFn answers with an opaque
    // changeset-create failure instead of anything a user can act on. The two
    // segment shapes are disjoint and unmistakable (an allocation id is
    // `eipalloc-…`; a public IP is a dotted quad), so discriminating costs
    // nothing and removes the dependency on the order entirely.
    const allocationFirst = first.startsWith(EIP_ALLOCATION_ID_PREFIX);
    const publicIp = allocationFirst ? second : first;
    const allocationId = allocationFirst ? first : second;
    // BOTH halves are checked, not just the allocation id: `eipalloc-a|eipalloc-b`
    // satisfies an allocation-id-only guard and then ships
    // `PublicIp: 'eipalloc-b'` — the very opaque changeset failure the shape
    // bind exists to prevent. A discriminator that validates one side only is
    // not a discriminator.
    if (
      !allocationId.startsWith(EIP_ALLOCATION_ID_PREFIX) ||
      !EIP_PUBLIC_IP_PATTERN.test(publicIp)
    ) {
      throw new Error(
        `'${physicalId}' is not an '<publicIp>|<allocationId>' pair: CloudFormation identifies ` +
          `an AWS::EC2::EIP by [PublicIp, AllocationId], so one segment must be an allocation ` +
          `id ('${EIP_ALLOCATION_ID_PREFIX}…') and the other a dotted-quad public IP. State ` +
          `entry may be corrupt or written by an older cdkd binary; re-deploy the resource to ` +
          `refresh state`
      );
    }
    return {
      resourceIdentifier: { PublicIp: publicIp, AllocationId: allocationId },
      propertiesOverlay: {},
    };
  },
  // cdkd's SDK provider stores the BARE `deploymentId` (apigateway-provider.ts's
  // `createDeployment`); the Cloud Control path stores `deploymentId|restApiId`.
  // CFn primary identifier is [DeploymentId, RestApiId] with `DeploymentId`
  // read-only, so the overlay narrows to `RestApiId` (issue #1692).
  'AWS::ApiGateway::Deployment': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Deployment',
    childField: 'DeploymentId',
    childFirstInCompositeId: true,
    narrowOverlayToRestApiId: true,
  }),
  // cdkd's SDK provider stores the BARE `stageName` (apigateway-provider.ts's
  // `createStage`); the Cloud Control path stores `restApiId|stageName`.
  // CFn primary identifier is [RestApiId, StageName] and the type has NO
  // read-only properties (live `DescribeType`, us-east-1, 2026-08-12), so the
  // default whole-map overlay is correct — `StageName` is a writable Property
  // the synth template already carries (issue #1692).
  'AWS::ApiGateway::Stage': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Stage',
    childField: 'StageName',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: false,
  }),
  // cdkd's SDK provider stores the BARE `authorizerId` (apigateway-provider.ts's
  // `createAuthorizer`); the Cloud Control path stores `restApiId|authorizerId`.
  // CFn primary identifier is [RestApiId, AuthorizerId] with `AuthorizerId`
  // read-only, so the overlay narrows to `RestApiId` (issue #1692).
  'AWS::ApiGateway::Authorizer': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Authorizer',
    childField: 'AuthorizerId',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: true,
  }),
  // cdkd has no SDK provider for this type, so it always routes through Cloud
  // Control, which stores `restApiId|name`. The bare form is still accepted so
  // a future SDK provider needs no state migration. CFn primary identifier is
  // [RestApiId, Name] and the type has NO read-only properties (live
  // `DescribeType`, us-east-1, 2026-08-12), so the default overlay is correct
  // — `Name` is a writable Property (issue #1692).
  'AWS::ApiGateway::Model': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Model',
    childField: 'Name',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: false,
  }),
  // cdkd has no SDK provider for this type either, so it routes through Cloud
  // Control, which stores `restApiId|requestValidatorId`. CFn primary
  // identifier is [RestApiId, RequestValidatorId] with `RequestValidatorId`
  // read-only, so the overlay narrows to `RestApiId` (issue #1692).
  'AWS::ApiGateway::RequestValidator': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::RequestValidator',
    childField: 'RequestValidatorId',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: true,
  }),
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
  // cdkd stores `<tableBucketARN>|<namespaceName>` (s3-tables-provider.ts's
  // `createNamespace`); CFn primary identifier is [TableBucketARN, Namespace] —
  // same order. Both fields are writable Properties the synth template already
  // carries (live `DescribeType`, us-east-1, 2026-08-13:
  // `readOnlyProperties` absent entirely, both fields `createOnlyProperties`
  // and `required`, both plain strings), so the default whole-map overlay is
  // correct and no narrowing is needed.
  //
  // Registered while live-testing issue #1659: without it, `cdkd export` aborts
  // on EVERY S3 Tables stack with "composite primary identifier (2 fields:
  // TableBucketARN, Namespace)", because CDK's `CfnTable` requires a namespace
  // and the namespace is its own resource. That made the sibling
  // `AWS::S3Tables::Table` identifier fix in this same change unreachable in
  // practice — a table cannot be exported without its namespace in the plan.
  //
  // `Namespace` is a STRING on both sides — measured 2026-08-13, because
  // `s3-tables-provider.ts` carried a comment claiming the CFn schema types it
  // `List<String>` (corrected in the same change as this note, issue #1771)
  // while that provider tolerates both wire shapes:
  //   - live `DescribeType`: `definitions.Namespace = {"type": "string"}`;
  //   - `aws-cdk-lib` 2.244.0 `CfnNamespaceProps.namespace: string`, and a
  //     synth of the typed prop emits `"Namespace": "analytics"`.
  // So the whole-map overlay below is right for every template CDK's typed API
  // can produce.
  //
  // An ARRAY is still REACHABLE, via `addPropertyOverride('Namespace', [...])`
  // (measured: it synthesizes `"Namespace": ["analytics"]`), and cdkd deploys
  // it because the provider accepts both. Such a template is not valid
  // CloudFormation — the registry types the property `string`, so CFn would
  // reject it on a plain CREATE too. The `resourceIdentifier` this splitter
  // builds is correct either way (it comes from the physicalId, not the
  // template), and since issue #1787 the shared overlay rule handles the
  // template side too: `overlayResourceIdentifierOnProperties` now overwrites
  // any literal — `["analytics"]` included — with the scalar identifier, and
  // refuses only a list carrying an intrinsic. So the array no longer survives
  // into the phase-1 template, and CFn no longer answers with an opaque
  // changeset-create rejection.
  'AWS::S3Tables::Namespace': (physicalId) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<tableBucketARN>|<namespaceName>'), got ${parts.length}: '${physicalId}'`
      );
    }
    const [tableBucketARN, namespace] = parts as [string, string];
    if (!tableBucketARN || !namespace) {
      throw new Error(`empty part in '<tableBucketARN>|<namespaceName>': '${physicalId}'`);
    }
    return { resourceIdentifier: { TableBucketARN: tableBucketARN, Namespace: namespace } };
  },
  // NOTE: `AWS::ApiGatewayV2::Stage` is intentionally NOT in this map — it is
  // handled by IMPORT_UNSUPPORTED_RECREATABLE_TYPES (pre-delete + phase-2
  // CREATE) instead, because AWS CloudFormation rejected it from IMPORT
  // changesets ("ResourceTypes [AWS::ApiGatewayV2::Stage] are not supported
  // for Import"), which blocked `cdkd export` on any stack with an HttpApi
  // (CDK auto-creates a `$default` Stage).
  //
  // BOTH facts this note used to assert are now stale, measured live
  // us-east-1 2026-08-13: the type reports `primaryIdentifier`
  // `[ApiId, StageName]` (not the single-key `['/properties/Id']` recorded
  // here) and `ProvisioningType: FULLY_MUTABLE` with a full handler set
  // INCLUDING `read` (not `handlers: []`). So the registry no longer says the
  // type is un-importable. Nothing is changed on that basis here — the
  // recreatable branch runs before any identifier resolution, so the arity
  // never reaches this map — but a re-test of whether the pre-delete dance
  // (and its ~10s unavailability window) is still needed is worth doing;
  // recorded rather than acted on because it is a behavior change for a type
  // this PR does not otherwise touch. Tracked in
  // [#1772](https://github.com/go-to-k/cdkd/issues/1772).

  // cdkd stores `<functionName>|<qualifier>` (lambda-event-invoke-config-
  // provider.ts's `buildPhysicalId`), split on the FIRST `|` — a Lambda function
  // name is `[a-zA-Z0-9-_]+` and a function ARN carries no `|`, which is the
  // premise `parsePhysicalId` documents and `packCompositeId` enforces. A BARE
  // function name is accepted and read as qualifier `$LATEST`, mirroring that
  // same `parsePhysicalId` (and CFn's own default for the unqualified config).
  //
  // CFn primary identifier is [FunctionName, Qualifier] — same order — and the
  // type declares NO `readOnlyProperties` at all (live `DescribeType`,
  // us-east-1, 2026-08-13; both fields are `required` + `createOnlyProperties`),
  // so the default whole-map overlay is correct: both are writable Properties
  // the synth template already carries, and writing them is what keeps CFn's
  // identifier-match check satisfied (issue #1771).
  'AWS::Lambda::EventInvokeConfig': (physicalId) => {
    if (!physicalId.trim()) {
      throw new Error(
        'empty physical id for AWS::Lambda::EventInvokeConfig ' +
          "(expected '<functionName>|<qualifier>' or a bare function name)"
      );
    }
    const separator = physicalId.indexOf('|');
    if (separator === -1) {
      return { resourceIdentifier: { FunctionName: physicalId, Qualifier: '$LATEST' } };
    }
    const functionName = physicalId.slice(0, separator);
    const qualifier = physicalId.slice(separator + 1);
    // `.trim()`, not truthiness: `'  |  '` clears the whole-id blank guard above
    // (it is not blank once split) and would otherwise ship
    // `FunctionName: '  '` into the changeset. Note the ApiGateway-family
    // splitters trim the WHOLE id only, not each segment — this is the stricter
    // per-segment check, matching `AWS::EC2::Route` / `AWS::EC2::EIP`.
    if (!functionName.trim() || !qualifier.trim()) {
      throw new Error(`empty part in '<functionName>|<qualifier>': '${physicalId}'`);
    }
    return { resourceIdentifier: { FunctionName: functionName, Qualifier: qualifier } };
  },
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

/**
 * The prefix every EC2 Elastic IP allocation id carries. Used to discriminate
 * the two segments of an `AWS::EC2::EIP` physicalId by SHAPE rather than by
 * position — see the splitter for why the order is not relied on.
 */
const EIP_ALLOCATION_ID_PREFIX = 'eipalloc-';

/**
 * The other half of the same discriminator: an Elastic IP's public address is
 * always a dotted quad (EIPs are IPv4-only). Shape-only — the octet RANGES are
 * not checked, because this exists to tell the two segments apart, not to
 * validate an address AWS itself minted.
 */
const EIP_PUBLIC_IP_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * The prefix every `AWS::EC2::VPCCidrBlock` association id carries. The same
 * kind of shape discriminator as {@link EIP_ALLOCATION_ID_PREFIX}: a VPC id and
 * an association id BOTH start with `vpc-`, so the longer prefix is what tells
 * the two segments apart.
 */
const VPC_CIDR_ASSOCIATION_ID_PREFIX = 'vpc-cidr-assoc-';

/**
 * The other half of that discriminator. ANCHORED, so an association id
 * (`vpc-cidr-assoc-…`, which also begins `vpc-`) does NOT match — a reversed
 * pair is exactly what this exists to catch.
 *
 * The character class is `[0-9a-z]` rather than hex, and the LENGTH is not
 * pinned. EC2 ids are hex today, but `cdkd export` is all-or-nothing, so a
 * false REFUSAL here blocks an entire export — and the discrimination does not
 * depend on the alphabet at all: it is the `-` in `cidr-assoc`, which no
 * character class here admits. Widening the class therefore costs nothing and
 * removes a false-refusal vector.
 */
const VPC_ID_PATTERN = /^vpc-[0-9a-z]+$/;

const GATEWAY_ATTACHMENT_TYPE_IGW = 'IGW';
const GATEWAY_ATTACHMENT_TYPE_VGW = 'VGW';

/**
 * The values AWS actually uses for `AWS::EC2::VPCGatewayAttachment`'s
 * `AttachmentType`, plus the two spellings issue #1691 guessed.
 *
 * `IGW` / `VGW` are what every real writer produces: Cloud Control stores the
 * primaryIdentifier verbatim, so a CC-written cdkd state record carries one of
 * them as segment 0. `InternetGateway` / `VPN` were never written by anything —
 * they were produced by THIS table on the way OUT, and CloudFormation rejects
 * them (`Invalid request provided: Invalid Attachment Type 'InternetGateway'`;
 * the IMPORT changeset never reaches CREATE_COMPLETE). They are kept purely as
 * input compatibility, so a physicalId hand-written from the old comment, or
 * supplied via `cdkd import --resource`, normalizes instead of falling through
 * to the property-derivation arms. Nothing in cdkd can put them in state.
 *
 * `Object.hasOwn` at the lookup site, not a bare index: a bare index on an
 * object literal answers for inherited members too, so a first segment of
 * `constructor` would resolve to a function rather than missing.
 */
const GATEWAY_ATTACHMENT_TYPE_ALIASES: Record<string, string> = {
  [GATEWAY_ATTACHMENT_TYPE_IGW]: GATEWAY_ATTACHMENT_TYPE_IGW,
  [GATEWAY_ATTACHMENT_TYPE_VGW]: GATEWAY_ATTACHMENT_TYPE_VGW,
  InternetGateway: GATEWAY_ATTACHMENT_TYPE_IGW,
  VPN: GATEWAY_ATTACHMENT_TYPE_VGW,
};

/**
 * Resolve `AttachmentType` for an `AWS::EC2::VPCGatewayAttachment` from the
 * first segment of cdkd's composite physicalId plus the recorded properties.
 *
 * The Cloud-Control-written shape already carries the attachment type verbatim
 * (it is the CFn primaryIdentifier's first field). The SDK-written shape
 * carries the gateway id instead, so the type is derived from WHICH gateway
 * property cdkd recorded — never hardcoded to the internet-gateway value, which
 * would ship a wrong identifier for a VPN attachment and make CFn's
 * identifier-match reject the import.
 *
 * The VALUES are `IGW` / `VGW`, measured live (Cloud Control `ListResources`,
 * us-east-1, 2026-08-13) against a VPC carrying both an internet-gateway and a
 * virtual-private-gateway attachment:
 *
 *   `IGW|vpc-…` -> {"AttachmentType":"IGW","VpcId":"vpc-…"}
 *   `VGW|vpc-…` -> {"AttachmentType":"VGW","VpcId":"vpc-…"}
 *
 * The registry schema does not enumerate them (`AttachmentType` is a bare
 * `{"type": "string"}` whose description only says it distinguishes the two
 * kinds), which is how the spelled-out `InternetGateway` / `VPN` guesses this
 * function shipped with in issue #1691 went unnoticed: they are plausible, they
 * satisfy every unit test written against them, and CFn only rejects them at
 * changeset-create time — measured 2026-08-13 as `Invalid request provided:
 * Invalid Attachment Type 'InternetGateway'` (issue #1771).
 */
function resolveGatewayAttachmentType(
  firstSegment: string,
  properties: Record<string, unknown>
): string {
  if (Object.hasOwn(GATEWAY_ATTACHMENT_TYPE_ALIASES, firstSegment)) {
    return GATEWAY_ATTACHMENT_TYPE_ALIASES[firstSegment]!;
  }
  if (typeof properties['InternetGatewayId'] === 'string' && properties['InternetGatewayId']) {
    return GATEWAY_ATTACHMENT_TYPE_IGW;
  }
  if (typeof properties['VpnGatewayId'] === 'string' && properties['VpnGatewayId']) {
    return GATEWAY_ATTACHMENT_TYPE_VGW;
  }
  // Last resort: the gateway id itself names the kind (`igw-…` / `vgw-…`).
  if (firstSegment.startsWith('igw-')) {
    return GATEWAY_ATTACHMENT_TYPE_IGW;
  }
  if (firstSegment.startsWith('vgw-')) {
    return GATEWAY_ATTACHMENT_TYPE_VGW;
  }
  throw new Error(
    `cannot determine AttachmentType for AWS::EC2::VPCGatewayAttachment: cdkd state's ` +
      `properties carry neither 'InternetGatewayId' nor 'VpnGatewayId', and the physical id ` +
      `segment '${firstSegment}' is not a recognized gateway id. State entry may be corrupt ` +
      `or written by an older cdkd binary; re-deploy the resource to refresh state.`
  );
}

/**
 * The `AWS::EC2::Route` destination keys, in CloudFormation's own precedence
 * order — the same order (and the same list) `narrowRouteDestinations` in
 * `src/provisioning/providers/ec2-provider.ts` resolves them in when it decides
 * which one `createRoute` actually sends, i.e. which one ends up in the
 * physicalId's destination segment. Restated here rather than imported so this
 * command does not pull the EC2 provider (and its SDK client) into the export
 * module graph.
 */
const ROUTE_DESTINATION_KEYS = [
  'DestinationCidrBlock',
  'DestinationIpv6CidrBlock',
  'DestinationPrefixListId',
] as const;

/**
 * Resolve the value CFn's read-only `AWS::EC2::Route.CidrBlock` identifier
 * field holds, from cdkd's physicalId destination segment plus the recorded
 * properties.
 *
 * The segment is the starting point — it is the destination cdkd sent to
 * `CreateRoute` (SDK path) or the `CidrBlock` AWS itself reported (Cloud Control
 * path), and `CidrBlock` holds whichever destination kind the route declares,
 * measured live; see the splitter's comment. But it is NOT returned verbatim:
 * EC2 clears host bits on the way in, so the SDK path can have stored a
 * destination AWS never held, and the identifier is always the CANONICAL form.
 *
 * The recorded properties are then read to CROSS-CHECK it, the way
 * {@link resolveGatewayAttachmentType} reads them to recover a field cdkd never
 * stores. Two very different things can make them disagree, and conflating them
 * is why this is not a plain warn:
 *
 *  - **Benign.** One side carries AWS's CANONICALIZED CIDR and the other what
 *    the user wrote; CFn documents rewriting e.g. `100.68.0.18/18` to
 *    `100.68.0.0/18`. The identifier is CORRECT here, so refusing would block an
 *    export that would have succeeded. Both sides are compared in canonical
 *    form, so this case never even registers as a divergence.
 *  - **Dangerous.** If state is merely stale, the id's destination can name a
 *    DIFFERENT route that still exists in the same table. IMPORT then succeeds
 *    against the wrong resource, and phase 2's UPDATE reconciles it to the
 *    template — REPLACING, i.e. DELETING, a route the user never targeted.
 *    Silently continuing here trades an opaque failure for data loss.
 *
 * So the outcome depends on whether the benign explanation is DECIDABLE, which
 * {@link routeDestinationNormalizationIsModelled} answers per declared value.
 * When every declared destination is a shape cdkd models — an IPv4 CIDR or a
 * prefix-list id — normalization either explains the difference or it does not,
 * and a non-match is refused. When any declared destination is an IPv6 CIDR,
 * whose AWS-side canonicalization cdkd does not reproduce, the divergence is
 * reported as a WARNING naming the replace-the-wrong-route outcome, because
 * refusing on an undecidable signal would block exports that are fine.
 *
 * Properties that declare NO destination at all are NOT treated as suspicious:
 * a partial / hand-edited state record must not become a refusal, and the id
 * alone is enough to build the identifier.
 */
function resolveRouteDestination(segment: string, properties: Record<string, unknown>): string {
  // CANONICALIZE FIRST, before any comparison or early return. `createRoute`
  // packs the destination it SENT into the physicalId, and EC2 rewrites host
  // bits on the way in (`100.68.0.18/18` -> `100.68.0.0/18`), so an SDK-written
  // state entry can hold a destination AWS never stored. Its recorded
  // properties hold that same non-canonical value, so the agreement check below
  // passes — and shipping the segment verbatim would hand CloudFormation an
  // identifier it cannot resolve, which is the exact opaque rejection this
  // function exists to prevent. Non-IPv4 shapes (IPv6 CIDR, `pl-…`) are
  // returned untouched: cdkd does not model their canonicalization.
  const identifier = canonicalizeIpv4Cidr(segment) ?? segment;

  const declared = ROUTE_DESTINATION_KEYS.filter(
    (key) => typeof properties[key] === 'string' && properties[key] !== ''
  );
  if (declared.length === 0) return identifier;

  const declaredValues = declared.map((key) => String(properties[key]));
  // Compare CANONICAL forms on both sides, so a host-bit difference between
  // what the template declares and what the id carries is recognized as the
  // same destination regardless of which side is the non-canonical one.
  if (declaredValues.some((value) => (canonicalizeIpv4Cidr(value) ?? value) === identifier)) {
    return identifier;
  }

  const recorded = declared.map((key) => `${key}='${String(properties[key])}'`).join(', ');
  const shared =
    `AWS::EC2::Route: cdkd state's recorded properties declare ${recorded}, but the physical ` +
    `id's destination segment is '${segment}'. CloudFormation identifies the route by the ` +
    `destination, so IMPORT would adopt whatever route currently sits at '${identifier}' — and ` +
    `if that is a DIFFERENT route than the template declares, phase 2 would then REPLACE ` +
    `(delete) it. The state entry is stale; re-deploy the resource to refresh it`;

  // Decidable when every declared destination is a shape whose AWS-side
  // normalization cdkd models: an IPv4 CIDR (canonicalized above) or a
  // prefix-list id (measured to be stored VERBATIM on both sides — Cloud
  // Control `GetResource`, us-east-1, 2026-08-13, reports
  // `CidrBlock: 'pl-63a5400a'` for a `DestinationPrefixListId` route). For
  // those, failing to explain the gap is conclusive: the id names a different
  // route, and continuing would import it and let phase 2 delete it.
  if (declaredValues.every((value) => routeDestinationNormalizationIsModelled(value))) {
    throw new Error(`${shared}.`);
  }

  getLogger().warn(
    `${shared}, or pass the resource through 'cdkd import --resource' with the correct id. ` +
      `Continuing with the physical id because at least one recorded destination is an IPv6 ` +
      `CIDR, whose AWS-side canonicalization cdkd does not model — so the difference may be ` +
      `benign.`
  );
  return identifier;
}

/**
 * An EC2 managed prefix list id (`pl-` + hex). Matched EXACTLY rather than by
 * prefix so a malformed value falls into the unmodelled class instead of being
 * treated as a comparable destination.
 */
const ROUTE_PREFIX_LIST_ID_PATTERN = /^pl-[0-9a-f]+$/;

/**
 * True when cdkd models how AWS normalizes this destination value, i.e. when a
 * mismatch against the physical id's segment is CONCLUSIVE rather than possibly
 * explained by a rewrite cdkd cannot reproduce.
 *
 * Two classes qualify:
 *   - an IPv4 CIDR, whose host-bit rewrite {@link canonicalizeIpv4Cidr} reproduces;
 *   - a prefix-list id, measured to be stored verbatim on both sides, so a
 *     `pl-AAA` vs `pl-BBB` difference is a genuine wrong-route signal.
 *
 * An IPv6 CIDR does not: AWS canonicalizes those too (zero-run compression,
 * host-bit clearing) and cdkd does not reproduce it, so a mismatch there could
 * still be the same route written two ways.
 */
function routeDestinationNormalizationIsModelled(value: string): boolean {
  return canonicalizeIpv4Cidr(value) !== undefined || ROUTE_PREFIX_LIST_ID_PATTERN.test(value);
}

/**
 * Return the host-bit-cleared form of an IPv4 CIDR (`100.68.0.18/18` ->
 * `100.68.0.0/18`), or `undefined` when the input is not an IPv4 CIDR at all
 * (an IPv6 CIDR, a `pl-…` prefix-list id, or anything malformed).
 *
 * This exists to recognize the ONE benign reason an `AWS::EC2::Route`'s stored
 * destination can differ from its physicalId segment: AWS rewrites a
 * non-canonical CIDR on `CreateRoute`, and the Cloud Control path records what
 * AWS returned while the template kept what the user wrote. Returning
 * `undefined` for the shapes it does not model is load-bearing — the caller
 * uses it to decide whether a divergence is conclusive or merely unexplained.
 */
function canonicalizeIpv4Cidr(value: string): string | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (!match) return undefined;
  const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map(Number);
  const prefixLength = Number(match[5]!);
  if (prefixLength > 32 || octets.some((octet) => octet > 255)) return undefined;
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (address & mask) >>> 0;
  const networkOctets = [
    network >>> 24,
    (network >>> 16) & 0xff,
    (network >>> 8) & 0xff,
    network & 0xff,
  ];
  return `${networkOctets.join('.')}/${prefixLength}`;
}

/**
 * Build a splitter for an `AWS::ApiGateway::*` child type whose CFn primary
 * identifier is the parent `RestApiId` plus one child field.
 *
 * Two stored shapes are accepted, because both exist in state in the wild:
 * the SDK providers store the BARE child value and read the parent from the
 * recorded properties, while a type routed through Cloud Control by the #614
 * silent-drop rule stores CC's `|`-joined composite — in CFn
 * primaryIdentifier order, which is why `childFirstInCompositeId` exists
 * (`AWS::ApiGateway::Deployment` declares `[DeploymentId, RestApiId]`, every
 * other member of the family declares `RestApiId` first).
 *
 * `narrowOverlayToRestApiId` is set for the types whose child field is
 * `readOnlyProperties` — writing one into the synth template's `Properties`
 * is rejected by CFn at changeset-create.
 */
function restApiChildSplitter(options: {
  resourceType: string;
  childField: string;
  childFirstInCompositeId: boolean;
  narrowOverlayToRestApiId: boolean;
}): CompositeIdSplitter {
  const { resourceType, childField, childFirstInCompositeId, narrowOverlayToRestApiId } = options;
  const compositeShape = childFirstInCompositeId
    ? `<${childField}>|<restApiId>`
    : `<restApiId>|<${childField}>`;

  return (physicalId, properties) => {
    // `.trim()`, not truthiness: a blank id is as unusable as an empty one and
    // would otherwise ship a whitespace identifier into the changeset.
    if (!physicalId.trim()) {
      throw new Error(`empty physical id for ${resourceType} (expected a ${childField})`);
    }
    const parts = physicalId.split('|');
    if (parts.length > 2) {
      throw new Error(
        `expected a bare ${childField} or '${compositeShape}', got ${parts.length} parts: ` +
          `'${physicalId}'`
      );
    }

    let restApiId: string;
    let childValue: string;
    if (parts.length === 2) {
      const [a, b] = parts as [string, string];
      if (!a || !b) {
        throw new Error(`empty part in '${compositeShape}': '${physicalId}'`);
      }
      [restApiId, childValue] = childFirstInCompositeId ? [b, a] : [a, b];
    } else {
      restApiId = readStringProperty(properties, 'RestApiId', resourceType);
      childValue = physicalId;
    }

    const resourceIdentifier = { RestApiId: restApiId, [childField]: childValue };
    return narrowOverlayToRestApiId
      ? { resourceIdentifier, propertiesOverlay: { RestApiId: restApiId } }
      : { resourceIdentifier };
  };
}

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
  // `Object.hasOwn`, not a bare index: an object literal answers for inherited
  // members too, so a resourceType of `constructor` / `toString` would resolve to
  // a FUNCTION here and fail somewhere confusing downstream instead of at this
  // not-registered check. Mirrors the `has*` predicates above.
  const splitter = Object.hasOwn(COMPOSITE_ID_SPLITTERS, resourceType)
    ? COMPOSITE_ID_SPLITTERS[resourceType]
    : undefined;
  if (!splitter) {
    throw new Error(`no composite-id splitter registered for ${resourceType}`);
  }
  return splitter(physicalId, properties);
}

/**
 * The cdkd state a {@link CompositePhysicalIdIdentifier} reads to recover the
 * value CloudFormation IMPORT wants.
 *
 * Deliberately NOT carrying the resource's `properties`: no entry needs it (an
 * identifier here is a value AWS minted, not one the template declares), and
 * the splitter family — which does need it, for a parent id like `ApiId` —
 * takes it as its own second argument. Add it back the day an entry has a use
 * for it, rather than passing a bag every resolve ignores.
 */
export interface CompositePhysicalIdContext {
  readonly logicalId: string;
  readonly physicalId: string;
  readonly attributes: Record<string, unknown>;
}

/**
 * The live-read seam a {@link CompositePhysicalIdIdentifier.backfill} may use.
 *
 * Separate from {@link CompositePhysicalIdContext} because the two answer
 * different questions and only one of them is optional: the context is what
 * cdkd RECORDED (always available), while these are the AWS clients needed to
 * go and ASK (available only on the real command path — a unit test, or any
 * caller that has none, simply gets the state-only refusal).
 */
export interface IdentifierBackfillDeps {
  readonly ec2Client: EC2Client;
  /**
   * Memo of the `DescribeSecurityGroupRules` walk, keyed by GROUP id, so N
   * rows sitting on one security group cost ONE paginated walk instead of N.
   * That is the common shape — a stack's ingress rules cluster on a handful of
   * groups — and every extra walk is also an extra chance to be throttled.
   *
   * Scoped to ONE {@link buildImportPlan} call by construction (see
   * {@link createIdentifierBackfillDeps}), never module-global: a module-level
   * cache would be shared across the stacks a `--concurrency > 1` run exports
   * in parallel, and the walk's answer is per-account/per-region.
   *
   * That scope is also, deliberately, NARROWER than the whole export: a
   * nested-stack tree runs one {@link buildImportPlan} per NODE (see
   * `runPerStackImportLoop`), so a security group referenced by rows in two
   * child stacks is walked once per child rather than once overall. That is
   * accepted, not overlooked. Hoisting the map to the loop would deduplicate
   * those few walks, but it would also keep every group's answer alive for the
   * whole multi-stack run — and the value being cached is a LIVE READ of AWS,
   * so the longer it lives the wider the window in which the rules it recorded
   * no longer describe the group. The saving is a handful of describes on an
   * uncommon shape; the cost is a stale answer feeding the exactly-one
   * adoption, which is the one thing this lookup must not get wrong. The memo
   * exists to stop the N-rows-on-one-group blowup, and that blowup is entirely
   * within one stack, where this scope already covers it.
   *
   * Caches the OUTCOME rather than the rules, so a failed walk is paid once
   * too, and caches a value that carries NO row identity — the per-row refusal
   * message is built by the caller from its own `logicalId`, or the second row
   * on a group would be refused in the first row's name.
   */
  readonly securityGroupRuleCache: Map<string, Promise<SecurityGroupRuleLookup>>;
}

/**
 * Build the live-read seam for ONE {@link buildImportPlan} call, with a fresh
 * memo. A factory rather than an inline object literal so the cache cannot be
 * forgotten at a future call site (the field is required, so omitting it is a
 * type error, and sharing one across calls has to be written deliberately).
 */
function createIdentifierBackfillDeps(ec2Client: EC2Client): IdentifierBackfillDeps {
  return { ec2Client, securityGroupRuleCache: new Map() };
}

interface CompositePhysicalIdIdentifier {
  /**
   * The type's CFn `primaryIdentifier` field name. Cross-checked against the
   * live registry schema before {@link resolve} runs, so a schema change under
   * cdkd surfaces as an explicit error rather than a wrong identifier.
   */
  readonly field: string;
  /**
   * Recover the identifier VALUE from cdkd state. Throws with an actionable
   * message when state does not carry it — the export is then blocked for that
   * resource instead of sending CFn something wrong.
   */
  readonly resolve: (ctx: CompositePhysicalIdContext) => string;
  /**
   * Recover the identifier VALUE from AWS when {@link resolve} could not
   * recover it from state (issue
   * [#1791](https://github.com/go-to-k/cdkd/issues/1791)).
   *
   * Reached ONLY after `resolve` threw AND the caller supplied
   * {@link IdentifierBackfillDeps} — see {@link resolveIdentifierValue}. That
   * ordering is what makes "a row whose state already carries the value issues
   * no AWS call" structural rather than a discipline each entry has to
   * re-implement.
   *
   * Throws — with a message naming the ROW and what was ambiguous — rather than
   * returning `undefined`, because the state-only refusal it replaces is a
   * worse answer once a live read has been performed: it would send the user to
   * a remedy (re-deploy) that this lookup has just proven irrelevant. A THROW
   * here is the same class of outcome as `resolve`'s: the resource lands in
   * `blocked` and the export aborts.
   *
   * Deliberately NOT a fallback that guesses: the SAME "exactly one match"
   * discipline `EC2Provider` applies on its idempotent already-exists arm binds
   * here, and for the same reason — adopting an ambiguous id records a state
   * row that looks adopted and names the wrong AWS object.
   */
  readonly backfill?: (
    ctx: CompositePhysicalIdContext,
    deps: IdentifierBackfillDeps
  ) => Promise<string>;
}

/**
 * Types whose cdkd physicalId is a COMPOSITE (`|`-joined) string while
 * CloudFormation's `primaryIdentifier` is a SINGLE field — so the physicalId is
 * NOT the identifier value, and it is not a SPLIT of the composite either
 * (issue [#1659](https://github.com/go-to-k/cdkd/issues/1659)).
 *
 * ## Why this table exists next to `COMPOSITE_ID_SPLITTERS`
 *
 * `resolveResourceIdentifier` used to conflate two independent questions: the
 * ARITY of the CFn identifier, and the FORMAT of cdkd's physical id. The
 * single-field branch assumed "the physicalId IS the identifier value", which
 * holds for every type whose id is a scalar and silently produces a wrong value
 * for a composite-id type whose CFn identifier happens to be single-field —
 * `{ TableARN: 'arn:aws:s3tables:...|analytics|events' }` for an
 * `AWS::S3Tables::Table`. `COMPOSITE_ID_SPLITTERS` cannot fix that: it is only
 * consulted on the multi-field branch, so registering a type there would add an
 * entry no code path reaches.
 *
 * This table is consulted BEFORE the arity branch, so the two concerns are
 * separated: a registered type never takes the "physicalId is the identifier"
 * assumption regardless of what the schema's field count says.
 *
 * ## Why a RESOLVE and not a split
 *
 * The correct identifier for each member is a different value entirely, not a
 * segment of the composite — an ARN AWS minted, or an `sgr-` rule id. So each
 * entry reads the value cdkd recorded in state (`attributes`), and refuses when
 * it is absent rather than guessing.
 *
 * ## Live measurement (us-east-1, 2026-08-13; the SG-ingress row 2026-08-14)
 *
 * Every field below is BOTH the type's single-field `primaryIdentifier` AND
 * `readOnlyProperties`, which is why each resolution returns an EMPTY
 * `propertiesOverlay`: writing a read-only property into the synth template's
 * `Properties` block is rejected by CFn at changeset-create.
 *
 * | Type | `primaryIdentifier` | recorded as |
 * |---|---|---|
 * | `AWS::AppSync::DataSource` | `DataSourceArn` | `attributes.DataSourceArn` |
 * | `AWS::AppSync::Resolver` | `ResolverArn` | `attributes.ResolverArn` |
 * | `AWS::S3Tables::Table` | `TableARN` | `attributes.TableARN` |
 * | `AWS::EC2::SecurityGroupIngress` | `Id` | `attributes.Id` (issue #1761) |
 *
 * The SG-ingress row is measured the same way as the rest, and separately
 * against a real CloudFormation stack because the three strings that name one
 * resource can disagree (issue #1771 found CFn reporting an EIP as the bare
 * public IP while Cloud Control reports the composite, and the two disagreeing
 * on field ORDER for `AWS::EC2::VPCGatewayAttachment`). For this type they all
 * AGREE: `describe-type` says `primaryIdentifier` / `readOnlyProperties` are
 * both exactly `["/properties/Id"]` with a full `create`/`delete`/`list`/
 * `read`/`update` handler set and `ProvisioningType: FULLY_MUTABLE`, and a live
 * stack carrying a standalone ingress rule reports `PhysicalResourceId`
 * `sgr-02345615af6d2db0d`, with `Ref` and `Fn::GetAtt .Id` both returning that
 * same value.
 *
 * All four declare a `read` handler, so CFn genuinely does accept them for
 * IMPORT — unlike `AWS::Glue::Table`, the type issue #1659's title names, which
 * CFn rejects outright (see {@link typeIsImportUnsupported}).
 */
const COMPOSITE_PHYSICAL_ID_IDENTIFIERS: Record<string, CompositePhysicalIdIdentifier> = {
  // cdkd stores `<apiId>|<name>` (appsync-provider.ts's `createDataSource`);
  // the ARN is recorded as an attribute since issue #1681.
  'AWS::AppSync::DataSource': recordedArnIdentifier({
    resourceType: 'AWS::AppSync::DataSource',
    field: 'DataSourceArn',
    physicalIdShape: '<apiId>|<name>',
    arnServiceSegment: 'appsync',
  }),
  // cdkd stores `<apiId>|<typeName>|<fieldName>` (appsync-provider.ts's
  // `createResolver`); the ARN is recorded as an attribute since issue #1681.
  'AWS::AppSync::Resolver': recordedArnIdentifier({
    resourceType: 'AWS::AppSync::Resolver',
    field: 'ResolverArn',
    physicalIdShape: '<apiId>|<typeName>|<fieldName>',
    arnServiceSegment: 'appsync',
  }),
  // cdkd stores `<tableBucketARN>|<namespace>|<name>` (s3-tables-provider.ts's
  // `createTable`), and records the real `TableARN` AWS returns — the ARN's
  // format is NOT derivable from the composite's parts. A Cloud-Control-routed
  // import records the bare ARN as the physicalId instead (see
  // `importTable`), which is why the bare-ARN fallback below is LIVE for this
  // type rather than defensive.
  'AWS::S3Tables::Table': recordedArnIdentifier({
    resourceType: 'AWS::S3Tables::Table',
    field: 'TableARN',
    physicalIdShape: '<tableBucketARN>|<namespace>|<name>',
    arnServiceSegment: 's3tables',
  }),
  // cdkd stores `<groupId>|<ipProtocol>|<fromPort>|<toPort>` (ec2-provider.ts's
  // `createSecurityGroupIngress`) — the tuple its own revoke call needs. CFn
  // identifies the rule by the `sgr-...` id AWS mints, which `EC2Provider`
  // records as the `Id` attribute since issue #1761 (read off
  // `AuthorizeSecurityGroupIngress`'s own response on the create path, off a
  // `DescribeSecurityGroupRules` lookup on the idempotent already-exists arm,
  // and off the adopted rule on the `--resource <logicalId>=sgr-…` import path).
  // Until then this entry was a pure REFUSAL, because there was no value in
  // state to resolve.
  'AWS::EC2::SecurityGroupIngress': recordedRuleIdIdentifier(),
};

/**
 * The `sgr-…` shape, anchored. Shape-only — the hex body's LENGTH is not
 * pinned, because this exists to tell the identifier apart from the two other
 * strings that can sit in the same state row, not to validate an id AWS itself
 * minted:
 *
 *  - cdkd's own composite physicalId, which starts `sg-` (the parent group) and
 *    carries `|` separators; and
 *  - a bare `sg-…` group id, which a hand-edited row could put under
 *    `attributes.Id`.
 *
 * Anchoring is what does the discriminating: `^sgr-[0-9a-f]+$` cannot match
 * either, because `|` and the composite's trailing segments have nowhere to go.
 * A bare `startsWith('sgr-')` would accept `sgr-abc|tcp|443|443`.
 *
 * Measured live (us-east-1, 2026-08-14) from a CloudFormation stack carrying a
 * standalone ingress rule: `PhysicalResourceId` = `sgr-02345615af6d2db0d`, and
 * both `Ref` and `Fn::GetAtt .Id` return that same value.
 */
const SG_RULE_ID_PATTERN = /^sgr-[0-9a-f]+$/;

/**
 * The {@link CompositePhysicalIdIdentifier} for `AWS::EC2::SecurityGroupIngress`.
 *
 * The `recordedArnIdentifier` sibling of the family, differing only in that the
 * identifier is an `sgr-` rule id rather than an ARN — so it gets its own
 * builder rather than an `isUsable` callback threaded through that one, which
 * would make the ARN family's every message ("which is not a <service> ARN",
 * "so cdkd records <field>") conditional on a shape it no longer owns.
 *
 * Two accepted sources, validated by the SAME predicate — the point #1771
 * made about the EIP splitter's segment binding applies here verbatim:
 * validating one side is not a discriminator.
 *
 * 1. `attributes.Id`, which every writer produces today — a fresh deploy, a
 *    `cdkd import --resource <logicalId>=sgr-…`, and the recursive
 *    `--migrate-from-cloudformation` walk (which hands CFn's
 *    `PhysicalResourceId` to `EC2Provider.import` as `knownPhysicalId`, and
 *    that value IS the `sgr-` id — measured above).
 * 2. A physicalId that is ALREADY the bare rule id. **No cdkd path writes this
 *    shape today** — unlike `AWS::S3Tables::Table`, whose Cloud-Control import
 *    genuinely records the bare ARN — so it is accepted defensively rather than
 *    because it is live: CFn's `PhysicalResourceId` for the type is exactly
 *    this string, so a row hand-repaired from a CFn console listing, or written
 *    by some future Cloud-Control routing of the type, carries an unambiguous
 *    identifier that it would be perverse to refuse. Such a row is separately
 *    BROKEN for `cdkd destroy` (`deleteSecurityGroupIngress` needs the 4-part
 *    tuple), which is another reason to let the export hand it to CFn rather
 *    than strand it.
 */
function recordedRuleIdIdentifier(): CompositePhysicalIdIdentifier {
  const isUsableIdentifier = (value: string): boolean => SG_RULE_ID_PATTERN.test(value.trim());

  return {
    field: 'Id',
    backfill: backfillSecurityGroupIngressRuleId,
    resolve: ({ logicalId, physicalId, attributes }) => {
      // Trimmed on RETURN as well as in the guard, matching the ARN family: a
      // padded value is otherwise shipped with the whitespace and CFn rejects
      // the identifier verbatim.
      const recorded = attributes['Id'];
      if (typeof recorded === 'string' && isUsableIdentifier(recorded)) {
        return recorded.trim();
      }
      if (isUsableIdentifier(physicalId)) {
        return physicalId.trim();
      }
      const recordedNote =
        typeof recorded === 'string' && recorded.trim()
          ? `attributes.Id is recorded as '${recorded.trim()}', which is not an 'sgr-…' ` +
            `security-group rule id`
          : `attributes.Id is missing or empty`;
      throw new Error(
        `cdkd's physical id for AWS::EC2::SecurityGroupIngress is the composite ` +
          `'<groupId>|<ipProtocol>|<fromPort>|<toPort>', but CloudFormation IMPORT identifies ` +
          `the rule by the 'sgr-...' security-group rule id AWS assigns, which cdkd state does ` +
          `not record usably for '${logicalId}' (${recordedNote}). Two causes, with different ` +
          `remedies. (1) The rule declares MORE THAN ONE source — e.g. both CidrIp and CidrIpv6 ` +
          `on the same resource — so AWS minted one rule per source and cdkd deliberately ` +
          `recorded neither id, because neither is 'the' identifier for this resource. ` +
          `Re-deploying does not help; split it into one AWS::EC2::SecurityGroupIngress ` +
          `resource per source, which is also the shape CloudFormation will manage after the ` +
          `export. (2) Otherwise the rule was deployed by a cdkd older than ` +
          `https://github.com/go-to-k/cdkd/issues/1761, which did not record the id at all. AWS ` +
          `returns it only from AuthorizeSecurityGroupIngress itself, so a no-op re-deploy will ` +
          `NOT heal the record either: change any property of the rule (cdkd revokes and ` +
          `re-authorizes, minting a fresh id, with a momentary traffic interruption) or destroy ` +
          `and re-deploy it, then re-run cdkd export. In both cases you can instead remove ` +
          `'${logicalId}' from the stack before exporting — the rule stays in AWS and can be ` +
          `re-declared in CloudFormation afterwards.`
      );
    },
  };
}

/**
 * Page ceiling for the {@link backfillSecurityGroupIngressRuleId} walk, and its
 * `MaxResults`. The twins of `MAX_SG_RULE_PAGES` / `SG_RULE_PAGE_SIZE` in
 * `src/provisioning/providers/ec2-provider.ts`, restated here for the same
 * reason {@link SG_RULE_ID_PATTERN} is: neither module may pull the other's
 * graph.
 *
 * 20 pages x 1000 rules covers 20,000 rules on ONE security group, far beyond
 * any real one (AWS's default quota is 60 rules per SG, 1000 at the maximum
 * increase). That arithmetic only holds because the request pins `MaxResults` —
 * without it AWS applies its own page size and the bound would cap an unknown
 * number of rules. Exhausting it is treated as "could not see the whole group",
 * which is a REFUSAL here rather than the provider's silent `undefined`: the
 * uniqueness verdict below is a statement about the whole group, so answering
 * from a partial view is exactly how a genuine 2-match becomes a false
 * "exactly one".
 */
const MAX_SG_RULE_PAGES = 20;
const SG_RULE_PAGE_SIZE = 1000;

/**
 * The `(protocol, fromPort, toPort)` triple cdkd's composite physical id
 * carries for an `AWS::EC2::SecurityGroupIngress`, plus the group it lives on.
 */
interface SecurityGroupIngressTuple {
  readonly groupId: string;
  readonly ipProtocol: string;
  readonly fromPort: number;
  readonly toPort: number;
}

/**
 * Parse cdkd's `<groupId>|<ipProtocol>|<fromPort>|<toPort>` physical id, or
 * `undefined` when it is not that shape.
 *
 * EXACTLY four segments, all non-blank. A longer id is the issue
 * [#1672](https://github.com/go-to-k/cdkd/issues/1672) ambiguity — a segment
 * carrying the separator — and decoding its first four parts would silently
 * look up a DIFFERENT rule's tuple, so it is refused like any other unparseable
 * shape.
 *
 * The ports are the `'-1'` AWS itself uses for "all ports", which is what
 * `EC2Provider` packs when the template declares no `FromPort` / `ToPort`; a
 * segment that is not a finite number yields `undefined` rather than `NaN`, so
 * a malformed id refuses instead of matching nothing and blaming AWS.
 *
 * A BLANK port segment is refused EXPLICITLY, before `Number()` ever sees it,
 * because `Number('')` is `0` rather than `NaN` — so `sg-x|tcp||443` would
 * otherwise parse to `fromPort: 0` and go and look up a REAL tuple (ICMP type
 * 0 is echo reply, a live rule shape), adopting an id for a rule the record
 * does not name. That is also why the blank is not simply folded to `-1`: this
 * module and `EC2Provider.cfnIngressPortValue` disagree about what a blank
 * MEANS — the provider reads it as `-1` (all ports) because its input is a CFn
 * property the template legitimately omits, while here it is a SEGMENT of an
 * id cdkd itself wrote, and cdkd never writes an empty one. A blank segment is
 * therefore evidence the id is damaged, not evidence of an absent port.
 */
function parseSecurityGroupIngressComposite(
  physicalId: string
): SecurityGroupIngressTuple | undefined {
  const parts = physicalId.trim().split('|');
  if (parts.length !== 4) return undefined;
  const [groupId, ipProtocol, fromPort, toPort] = parts as [string, string, string, string];
  if (!groupId.trim() || !ipProtocol.trim()) return undefined;
  const fromRaw = fromPort.trim();
  const toRaw = toPort.trim();
  if (!fromRaw || !toRaw) return undefined;
  const from = Number(fromRaw);
  const to = Number(toRaw);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  return { groupId: groupId.trim(), ipProtocol: ipProtocol.trim(), fromPort: from, toPort: to };
}

/**
 * Does this `DescribeSecurityGroupRules` row describe the rule cdkd's composite
 * physical id names?
 *
 * The protocol goes through {@link canonicalizeIpProtocolValue} on BOTH sides
 * rather than a raw compare: EC2 rewrites the four protocol numbers it has a
 * name for before storing the rule, so a record packed from `IpProtocol: 6`
 * carries `'6'` while the readback says `'tcp'` and a raw compare would match
 * nothing (the issue #1643 fold, at a fourth call site).
 *
 * An omitted port reads back as `-1`, which is the same spelling the composite
 * carries for an absent one — so the two sides are directly comparable.
 */
function ruleMatchesIngressTuple(
  rule: SecurityGroupRule,
  tuple: SecurityGroupIngressTuple
): boolean {
  // `=== true`, not `!== false`: an ABSENT `IsEgress` counts as ingress. That
  // asymmetry is deliberate and matches `EC2Provider.lookupIngressRuleId` —
  // tightening it to `=== false` would make every rule AWS ever reports
  // without the field unmatchable, turning a healable row into a permanent
  // "found NO ingress rule" refusal. AWS populates the field today; the
  // looser test costs nothing while it does, and keeps healing working if it
  // ever stops.
  if (rule.IsEgress === true) return false;
  if (
    canonicalizeIpProtocolValue(rule.IpProtocol) !== canonicalizeIpProtocolValue(tuple.ipProtocol)
  )
    return false;
  if ((rule.FromPort ?? -1) !== tuple.fromPort) return false;
  if ((rule.ToPort ?? -1) !== tuple.toPort) return false;
  return true;
}

/**
 * Outcome of ONE security group's paginated `DescribeSecurityGroupRules` walk.
 *
 * Carries NO row identity on purpose: it is what the per-group memo stores, so
 * a second row on the same group must be able to build its own refusal from
 * it. A cached `Error` would name whichever row happened to walk first.
 */
type SecurityGroupRuleLookup =
  | { readonly ok: true; readonly rules: SecurityGroupRule[] }
  | {
      readonly ok: false;
      /**
       * The walk was still paginating at the page ceiling. Carries NO
       * `detail`, unlike the failure kinds below: there is no AWS error text
       * to quote, and the only other thing this arm could carry — the group
       * id — is one the caller already holds on its own tuple. A copy here
       * would be a second place for it to go stale and a field the message
       * never reads.
       */
      readonly kind: 'truncated';
    }
  | {
      readonly ok: false;
      /** Which remedy the caller's message should prescribe. */
      readonly kind: 'auth' | 'throttled' | 'failed';
      /** The AWS failure text, quoted verbatim into the caller's refusal. */
      readonly detail: string;
    };

/**
 * Test seam: overriding `sleep` lets unit tests drive the throttle backoff
 * without real waits. Mirrors `describeTypeRetryDelays` in
 * `src/provisioning/describe-type.ts`, which this retry is modeled on.
 */
export const securityGroupRuleLookupRetryDelays: { sleep?: (ms: number) => Promise<void> } = {};

/**
 * Retries after the first attempt, THROTTLE-shaped failures only. At the
 * default backoff (1s -> 2s -> 4s -> 8s) this adds at most ~15s of sleep,
 * which is small next to what it prevents: `cdkd export` is all-or-nothing, so
 * one `RequestLimitExceeded` — the commonest EC2 Describe failure there is —
 * would otherwise abort the WHOLE run. A non-throttle failure (a missing
 * `ec2:DescribeSecurityGroupRules` being the important one) is surfaced
 * immediately, since it cannot heal by waiting.
 */
const MAX_SG_RULE_THROTTLE_RETRIES = 4;

/**
 * Does this failure say the CALLER lacks permission, as opposed to anything
 * else AWS can fail with?
 *
 * Only these get the "Grant ec2:DescribeSecurityGroupRules" sentence. Sending
 * every failure to that remedy is how a throttle got reported as a permissions
 * problem: the user checks a policy that was correct all along, while the
 * actual advice ("re-run it") goes unsaid.
 */
function isAuthorizationShapedError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  return /AccessDenied|UnauthorizedOperation|AuthFailure|not authorized to perform/i.test(
    `${name} ${message}`
  );
}

/**
 * Walk EVERY ingress/egress rule AWS holds on one security group, retrying a
 * throttled page (issue [#1791](https://github.com/go-to-k/cdkd/issues/1791)
 * review).
 *
 * Returns the failure rather than throwing it, because the caller owns the
 * message: every refusal here names the cdkd ROW that could not be resolved,
 * and this function does not know which row (possibly rows, via the memo)
 * asked.
 */
async function describeAllSecurityGroupRules(
  groupId: string,
  ec2Client: EC2Client
): Promise<SecurityGroupRuleLookup> {
  const rules: SecurityGroupRule[] = [];
  let nextToken: string | undefined;
  let pages = 0;
  do {
    if (pages >= MAX_SG_RULE_PAGES) {
      return { ok: false, kind: 'truncated' };
    }
    let resp: DescribeSecurityGroupRulesResult;
    try {
      resp = await withRetry(
        () =>
          ec2Client.send(
            new DescribeSecurityGroupRulesCommand({
              Filters: [{ Name: 'group-id', Values: [groupId] }],
              MaxResults: SG_RULE_PAGE_SIZE,
              ...(nextToken && { NextToken: nextToken }),
            })
          ),
        `DescribeSecurityGroupRules(${groupId})`,
        {
          maxRetries: MAX_SG_RULE_THROTTLE_RETRIES,
          isRetryable: (_message, error) => isThrottlingError(error),
          logger: getLogger().child('Export'),
          ...(securityGroupRuleLookupRetryDelays.sleep
            ? { sleep: securityGroupRuleLookupRetryDelays.sleep }
            : {}),
        }
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const kind = isAuthorizationShapedError(err)
        ? 'auth'
        : isThrottlingError(err)
          ? 'throttled'
          : 'failed';
      return { ok: false, kind, detail };
    }
    rules.push(...(resp.SecurityGroupRules ?? []));
    nextToken = resp.NextToken;
    pages += 1;
  } while (nextToken);
  return { ok: true, rules };
}

/**
 * {@link describeAllSecurityGroupRules}, memoized per GROUP for the lifetime of
 * one {@link buildImportPlan} call — see
 * {@link IdentifierBackfillDeps.securityGroupRuleCache}.
 *
 * The PROMISE is cached, not its resolution, so rows resolved concurrently on
 * one group also share a single walk rather than racing to start their own.
 */
function cachedSecurityGroupRules(
  groupId: string,
  { ec2Client, securityGroupRuleCache }: IdentifierBackfillDeps
): Promise<SecurityGroupRuleLookup> {
  const cached = securityGroupRuleCache.get(groupId);
  if (cached) return cached;
  const pending = describeAllSecurityGroupRules(groupId, ec2Client);
  securityGroupRuleCache.set(groupId, pending);
  return pending;
}

/**
 * What to DO about a row more than one AWS rule matches — the part of the
 * refusal that is about the ambiguity itself rather than about how cdkd
 * noticed it.
 *
 * Written once because TWO arms below report a matched count above one: the
 * plain `> 1` refusal, and the unusable-id refusal (whose own remedy is "open
 * a cdkd issue" — right about the unreadable id, useless about the ambiguity).
 * A row that hits the second arm has BOTH problems, and before this was shared
 * it was the one row whose user never saw these two causes at all.
 *
 * Carries no row identity, so it can be appended to either message.
 */
const SG_INGRESS_AMBIGUITY_REMEDY =
  `Two causes, with different remedies. (1) ONE resource declaring MORE THAN ONE source (e.g. ` +
  `both CidrIp and CidrIpv6 on the same resource), for which AWS mints one rule per source: ` +
  `split it into one AWS::EC2::SecurityGroupIngress resource per source, which is also the ` +
  `shape CloudFormation will manage after the export. (2) TWO DISTINCT ` +
  `AWS::EC2::SecurityGroupIngress resources that differ only by SOURCE — port 443 from a CIDR ` +
  `and port 443 from a peer security group, say. cdkd's composite physical id carries no ` +
  `source, so those two rows carry byte-identical ids and splitting is not their remedy: set ` +
  `the row's attributes.Id to the 'sgr-...' id that belongs to it (cdkd then resolves from ` +
  `state and issues no lookup at all), or remove the row from the stack before exporting. Then ` +
  `re-run cdkd export.`;

/** The remedy every refusal below ends with — one place, so they cannot drift. */
function sgIngressExportEscapeHatch(logicalId: string): string {
  return (
    `You can instead remove '${logicalId}' from the stack before exporting — the rule stays in ` +
    `AWS and can be re-declared in CloudFormation afterwards.`
  );
}

/**
 * Live-read backfill of the `sgr-...` rule id for an
 * `AWS::EC2::SecurityGroupIngress` row that state does not carry one for
 * (issue [#1791](https://github.com/go-to-k/cdkd/issues/1791)).
 *
 * ## Why a live read at all
 *
 * Every row written by a cdkd older than issue #1761 has `attributes: {}`, and
 * `cdkd export` is ALL-OR-NOTHING — so ONE such row makes a whole stack
 * un-exportable. The obvious workaround does not exist: AWS returns the id only
 * from `AuthorizeSecurityGroupIngress`'s own response, so a no-op `cdkd deploy`
 * records nothing and the row is exactly as unexportable afterwards. Only a
 * re-authorization (a property change, or a destroy + deploy) heals it, which
 * is a traffic interruption to pay for a read cdkd can perform itself.
 *
 * ## Why the match is on the composite's tuple, and why EXACTLY ONE
 *
 * The row's identity, as far as cdkd state is concerned, IS
 * `<groupId>|<ipProtocol>|<fromPort>|<toPort>` — the tuple its own revoke call
 * needs. So the tuple is the most cdkd can filter on, and two AWS rules sharing
 * it are two rules cdkd's own physical id cannot tell apart either. Adopting
 * one of them would record an identifier that names the wrong AWS object, which
 * is the failure mode the #1761 already-exists arm's "exactly one" rule exists
 * to prevent — so ambiguity REFUSES, naming the candidates.
 *
 * The commonest ambiguity is the multi-source rule the state-only message
 * already describes: a resource declaring both `CidrIp` and `CidrIpv6` makes
 * AWS mint one rule PER SOURCE, both with this exact tuple. Splitting the
 * resource is the remedy in that case, and it is the same remedy CloudFormation
 * will want after the export. It is NOT the only cause, which is why the
 * refusal names two: TWO DISTINCT `AWS::EC2::SecurityGroupIngress` resources
 * differing only by source share one tuple as well — cdkd's composite carries
 * no source — and those are already one resource per source, so the remedy
 * there is to repair the row's `attributes.Id` (or drop the row) instead.
 *
 * Deliberately NOT narrowed by the recorded SOURCE (`CidrIp` and friends) even
 * though state carries it: {@link CompositePhysicalIdContext} does not carry
 * `properties`, and widening it to make ONE ambiguous case resolvable would
 * also make the export adopt a rule the physical id in state does not uniquely
 * name — a row that looks adopted while `cdkd destroy` would revoke a different
 * one. Refusing is the answer that keeps state and AWS agreeing.
 */
async function backfillSecurityGroupIngressRuleId(
  { logicalId, physicalId }: CompositePhysicalIdContext,
  deps: IdentifierBackfillDeps
): Promise<string> {
  const tuple = parseSecurityGroupIngressComposite(physicalId);
  if (!tuple) {
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for '${logicalId}', and its ` +
        `physical id '${physicalId}' is not cdkd's ` +
        `'<groupId>|<ipProtocol>|<fromPort>|<toPort>' composite either, so cdkd cannot look the ` +
        `rule up in AWS to recover the id CloudFormation IMPORT needs. Repair the record's ` +
        `physicalId (or its attributes.Id, which may be the 'sgr-...' id verbatim) and re-run ` +
        `cdkd export. ${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  const portRange =
    tuple.fromPort === tuple.toPort ? `${tuple.fromPort}` : `${tuple.fromPort}-${tuple.toPort}`;
  const tupleNote = `protocol '${tuple.ipProtocol}', ports ${portRange} on security group '${tuple.groupId}'`;

  const lookup = await cachedSecurityGroupRules(tuple.groupId, deps);
  if (!lookup.ok) {
    if (lookup.kind === 'truncated') {
      throw new Error(
        `cdkd state records no 'sgr-...' security-group rule id for '${logicalId}', and the ` +
          `DescribeSecurityGroupRules lookup on '${tuple.groupId}' was still paginating after ` +
          `${MAX_SG_RULE_PAGES} pages — cdkd cannot prove a match is unique without seeing the ` +
          `whole group, and adopting an unproven id would name the wrong rule. ` +
          `${sgIngressExportEscapeHatch(logicalId)}`
      );
    }
    // One remedy per CAUSE. "Grant the permission" is right for exactly one of
    // these three, and saying it for a throttle sends the user to audit a
    // policy that was never the problem.
    const remedy =
      lookup.kind === 'auth'
        ? `Grant ec2:DescribeSecurityGroupRules and re-run cdkd export.`
        : lookup.kind === 'throttled'
          ? `AWS throttled the lookup and cdkd retried it ${MAX_SG_RULE_THROTTLE_RETRIES} times ` +
            `before giving up — no permission is missing. Re-run cdkd export once the account's ` +
            `EC2 describe rate has recovered.`
          : `Re-run cdkd export once that cause is resolved.`;
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for '${logicalId}' (the rule was ` +
        `deployed by a cdkd older than https://github.com/go-to-k/cdkd/issues/1761), and the ` +
        `DescribeSecurityGroupRules lookup that would have recovered it failed: ` +
        `${lookup.detail}. ${remedy} ${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  // The MATCHES are counted BEFORE any is discarded for carrying an unusable
  // id, because "exactly one" is a claim about how many rules match — not
  // about how many usable ids survived a filter. Folding the two together
  // collapses a genuine 2-match whose other candidate AWS reported without an
  // id into `length === 1` and adopts the survivor, which is precisely the
  // wrong-rule adoption this discipline exists to prevent (and it made the
  // zero case report "found NO ingress rule matching <tuple>" when rules did
  // in fact match).
  const matched = lookup.rules.filter((rule) => ruleMatchesIngressTuple(rule, tuple));
  const ids = matched
    .map((rule) => rule.SecurityGroupRuleId)
    .filter((id): id is string => typeof id === 'string' && SG_RULE_ID_PATTERN.test(id.trim()))
    .map((id) => id.trim());

  // No `matched.length > 0 &&` guard: `ids` is derived from `matched` by a
  // filter, so an empty `matched` gives an empty `ids` and `0 < 0` is already
  // false. The conjunct could not change the answer, and a reader who found it
  // there would reasonably assume it could.
  if (ids.length < matched.length) {
    const unusable = matched
      .filter(
        (rule) =>
          !(
            typeof rule.SecurityGroupRuleId === 'string' &&
            SG_RULE_ID_PATTERN.test(rule.SecurityGroupRuleId.trim())
          )
      )
      .map((rule) =>
        typeof rule.SecurityGroupRuleId === 'string' ? `'${rule.SecurityGroupRuleId}'` : '<absent>'
      );
    // A matched count above one means this row is ALSO the genuine ambiguity
    // case, and the unreadable id is then the lesser of its two problems: even
    // if AWS had reported every id, cdkd still could not say which rule the row
    // is. Without this the user gets "open a cdkd issue" and never sees the
    // remedy they can actually act on, because that remedy lives only in the
    // `> 1` message this branch pre-empts.
    // The remedy tells the user to set `attributes.Id` to the id that belongs
    // to this row, so name the ids cdkd COULD read — otherwise it asks them to
    // pick a value it saw and withheld.
    const readableNote =
      ids.length > 0
        ? ` The readable candidates cdkd did see: ${ids.map((id) => `'${id}'`).join(', ')}.`
        : '';
    const ambiguityNote =
      matched.length > 1
        ? ` Note that ${matched.length} rules matching one row is an ambiguity in its own ` +
          `right, which cdkd could not resolve even if every id were readable: ` +
          `${SG_INGRESS_AMBIGUITY_REMEDY}${readableNote}`
        : '';
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for '${logicalId}', and a live ` +
        `DescribeSecurityGroupRules lookup found ${matched.length} ingress rule(s) matching ` +
        `${tupleNote}, but ${unusable.length} of them carry no usable 'sgr-...' rule id (AWS ` +
        `reported ${unusable.join(', ')}). cdkd adopts an id only on an EXACTLY ONE match, and ` +
        `that is a count of MATCHING RULES — so discarding the unreadable ones first would let ` +
        `a genuine two-match pass as "exactly one" and record an identifier naming the wrong ` +
        `rule. cdkd refuses instead. This is a DescribeSecurityGroupRules response shape cdkd ` +
        `does not expect; please open a cdkd issue if it persists.${ambiguityNote} ` +
        `${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  if (ids.length === 1) return ids[0]!;

  if (ids.length === 0) {
    throw new Error(
      `cdkd state records no 'sgr-...' security-group rule id for '${logicalId}' (the rule was ` +
        `deployed by a cdkd older than https://github.com/go-to-k/cdkd/issues/1761), and a live ` +
        `DescribeSecurityGroupRules lookup found NO ingress rule matching ${tupleNote} — so ` +
        `cdkd has no id to hand CloudFormation IMPORT. Either the rule was revoked outside cdkd, ` +
        `or the group lives in a region other than the one this export is running against. Run ` +
        `cdkd deploy to reconcile the stack, then re-run cdkd export. ` +
        `${sgIngressExportEscapeHatch(logicalId)}`
    );
  }

  throw new Error(
    `cdkd state records no 'sgr-...' security-group rule id for '${logicalId}', and a live ` +
      `DescribeSecurityGroupRules lookup found ${ids.length} ingress rules matching ${tupleNote} ` +
      `(${ids.join(', ')}). cdkd's physical id identifies a rule only by group, protocol and ` +
      `port range, so it cannot say which of them '${logicalId}' is, and CloudFormation IMPORT ` +
      `needs exactly one — adopting either would record the wrong rule. ` +
      `${SG_INGRESS_AMBIGUITY_REMEDY} ${sgIngressExportEscapeHatch(logicalId)}`
  );
}

/**
 * Resolve a registered type's CFn identifier VALUE, consulting AWS only when
 * cdkd state could not answer (issue
 * [#1791](https://github.com/go-to-k/cdkd/issues/1791)).
 *
 * The ordering is the whole design: `resolve` is tried FIRST and its throw is
 * the only trigger for the live read, so a row whose state already carries the
 * identifier — every row written by a current cdkd — issues no AWS call at all,
 * and a caller with no {@link IdentifierBackfillDeps} keeps exactly the
 * pre-#1791 behavior (the state-only refusal, verbatim).
 *
 * The backfill's own error REPLACES the state-only one when it fires: by then
 * cdkd has asked AWS, so the state-only message's central remedy ("re-deploy so
 * cdkd records the id") is not merely unhelpful but has been disproven for this
 * row — the live read already found zero, or too many.
 */
async function resolveIdentifierValue(
  entry: CompositePhysicalIdIdentifier,
  ctx: CompositePhysicalIdContext,
  deps: IdentifierBackfillDeps | undefined
): Promise<string> {
  try {
    return entry.resolve(ctx);
  } catch (stateOnlyError) {
    if (!entry.backfill || !deps) throw stateOnlyError;
    return await entry.backfill(ctx, deps);
  }
}

/**
 * Build the {@link CompositePhysicalIdIdentifier} for a type whose CFn
 * identifier is an ARN cdkd records in `attributes` under the SAME name as the
 * `primaryIdentifier` field.
 *
 * Two accepted sources, mirroring the splitter family's "both shapes exist in
 * state in the wild" contract:
 *
 * 1. the recorded attribute, which is what a fresh deploy and a cdkd `import`
 *    both write; and
 * 2. a physicalId that is ALREADY the bare ARN. Two live producers:
 *    `S3TablesProvider.importTable` records it for a Cloud-Control-routed
 *    table (CC's identifier for the type IS the ARN), and an AppSync child
 *    adopted through `cdkd import --migrate-from-cloudformation` records
 *    CloudFormation's `PhysicalResourceId` verbatim, which is likewise the
 *    ARN.
 *
 * **Both sources are validated by the SAME predicate.** An earlier cut checked
 * the ARN's shape only on source 2 — the rare one — while source 1, which
 * fires on essentially every export, accepted any non-blank string verbatim.
 * That is the wrong way round: a hand-edited state row, a row written by an
 * older binary that recorded the composite under the attribute name, or an ARN
 * for a different service sitting under `attributes.<field>` would each have
 * been shipped as the IMPORT identifier and silently adopted the WRONG
 * resource, which is precisely what this table exists to prevent.
 *
 * Anything failing both sources is refused. That covers the degraded record
 * `docs/state-management.md` describes — written by a cdkd older than the fix
 * that started recording the ARN, or by an import that could not reach STS —
 * and the remedy is the one that doc already gives.
 */
function recordedArnIdentifier(options: {
  resourceType: string;
  field: string;
  physicalIdShape: string;
  arnServiceSegment: string;
}): CompositePhysicalIdIdentifier {
  const { resourceType, field, physicalIdShape, arnServiceSegment } = options;

  /**
   * Is this value usable AS the type's CFn identifier?
   *
   * - `arn:` prefix and the type's own SERVICE segment: an ARN naming another
   *   service is a different value entirely. Partition-agnostic by
   *   construction, so `arn:aws-cn:s3tables:...` matches.
   * - no `|`: cdkd's composite for `AWS::S3Tables::Table` is built FROM the
   *   bucket ARN, so it satisfies both checks above — the separator test is
   *   what distinguishes the composite from the identifier, on BOTH sources.
   */
  const isUsableIdentifier = (value: string): boolean => {
    const trimmed = value.trim();
    return (
      trimmed.startsWith('arn:') &&
      trimmed.includes(`:${arnServiceSegment}:`) &&
      !trimmed.includes('|')
    );
  };

  return {
    field,
    resolve: ({ logicalId, physicalId, attributes }) => {
      // Trimmed on RETURN as well as in the guard — a padded / newline-suffixed
      // ARN is otherwise shipped with the whitespace and CFn rejects the
      // identifier verbatim.
      const recorded = attributes[field];
      if (typeof recorded === 'string' && isUsableIdentifier(recorded)) {
        return recorded.trim();
      }
      if (isUsableIdentifier(physicalId)) {
        return physicalId.trim();
      }
      const recordedNote =
        typeof recorded === 'string' && recorded.trim()
          ? `attributes.${field} is recorded as '${recorded.trim()}', which is not a ` +
            `${arnServiceSegment} ARN`
          : `attributes.${field} is missing or empty`;
      throw new Error(
        `cdkd's physical id for ${resourceType} is the composite '${physicalIdShape}', but ` +
          `CloudFormation IMPORT identifies the resource by its ${field}, which cdkd state does ` +
          `not record usably for '${logicalId}' (${recordedNote}). Re-deploy the stack once so ` +
          `cdkd records ${field}, then re-run cdkd export.`
      );
    },
  };
}

/**
 * Every type registered in {@link COMPOSITE_PHYSICAL_ID_IDENTIFIERS}. Exported
 * so a test can assert the table's SIZE, not just membership — a new entry
 * needs a measurement row in the table's doc comment, and a size-blind test
 * would let one land silently.
 */
export const COMPOSITE_PHYSICAL_ID_IDENTIFIER_TYPES: readonly string[] = Object.keys(
  COMPOSITE_PHYSICAL_ID_IDENTIFIERS
);

/**
 * Returns true if cdkd resolves the type's CFn identifier from recorded state
 * rather than from its physical id. Exported for unit tests and for ad-hoc
 * inspection alongside {@link hasCompositeIdSplitter}.
 */
export function hasCompositePhysicalIdIdentifier(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMPOSITE_PHYSICAL_ID_IDENTIFIERS, resourceType);
}

/**
 * Exported for unit tests — resolve the CFn identifier value for a registered
 * composite-physicalId type from the given cdkd state. Throws when no entry is
 * registered (same shape as `splitCompositePhysicalId`'s no-splitter error).
 *
 * INSPECTION / TEST ONLY, and deliberately STATE-ONLY: it calls `entry.resolve`
 * and never `entry.backfill`, so a row a live read could heal (issue #1791)
 * throws here. Wiring this into a command path would silently lose the
 * backfill — the command path goes through {@link resolveResourceIdentifier}
 * (and thus {@link resolveIdentifierValue}), which is where the AWS clients are
 * available to consult.
 */
export function resolveCompositePhysicalIdIdentifier(
  resourceType: string,
  ctx: CompositePhysicalIdContext
): { field: string; value: string } {
  // `Object.hasOwn`, not a bare index: an object literal answers for inherited
  // members too, so a resourceType of `constructor` / `toString` would resolve to
  // a FUNCTION here and fail somewhere confusing downstream instead of at this
  // not-registered check. Mirrors the `has*` predicates above.
  const entry = Object.hasOwn(COMPOSITE_PHYSICAL_ID_IDENTIFIERS, resourceType)
    ? COMPOSITE_PHYSICAL_ID_IDENTIFIERS[resourceType]
    : undefined;
  if (!entry) {
    throw new Error(`no composite-physicalId identifier registered for ${resourceType}`);
  }
  return { field: entry.field, value: entry.resolve(ctx) };
}

export interface ImportPlanEntry {
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
 * --type-name <T> | jq .handlers` — types with `handlers: []` (or a
 * missing `read` / `list` handler that prevents CFn from looking the
 * resource up by identifier) are candidates. Currently registered:
 * `AWS::ApiGatewayV2::Stage` (no handlers at all) and `AWS::IAM::Policy`
 * (no `read` / `list` — inline policy attachments have no first-class
 * AWS resource id). See the per-entry comment for each addition.
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

  // Issue #2065 - fold `--region` ONCE, at the boundary, so no raw spelling
  // reaches an SDK client, an ARN segment or a state key. Rationale (and why
  // this is per-command rather than per-consumer) in `src/cli/region-options.ts`.
  foldRegionOption(options);
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const region = namedCliRegion(options.region) ?? 'us-east-1';
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
    // The format we will re-emit the template in when we send phase-1 /
    // phase-2 changesets to CloudFormation. CDK synth always produces
    // JSON; the only path that can introduce YAML is `--template <path>`,
    // where we sniff the file content via the CFn-aware codec.
    let templateFormat: TemplateFormat = 'json';
    // Set when synth runs (not when --template is used). Captures all
    // stacks in the user's CDK app, used by the cross-stack consumer
    // scan to detect Fn::GetStackOutput references to the exporting
    // stack from sibling stacks.
    let allSynthStacks: Array<{ stackName: string; template: unknown }> = [];
    // Per-logical-id absolute paths to nested-stack child templates next to
    // the root stack's template in cdk.out. Populated from
    // `stackInfo.nestedTemplates`. Used by the per-stack IMPORT loop
    // (#464 PR B2) to recursively load every child template body; empty
    // for flat stacks AND for the `--template` path (the user-supplied
    // template file has no nested-template side cars cdkd could load).
    let rootNestedTemplatePaths: Record<string, string> = {};

    if (options.template) {
      // User-supplied template path: still need a stack name to load state.
      if (!stackArg) {
        throw new Error(
          '--template requires a stack name as a positional argument to identify the cdkd state record.'
        );
      }
      const parsed = parseTemplateFile(options.template);
      template = parsed.template;
      templateFormat = parsed.format;
      resolvedStackName = stackArg;
    } else {
      const appCmd = options.app || resolveApp();
      if (!appCmd) {
        throw new Error(
          "'cdkd export' requires a CDK app (pass --app or set it in cdk.json) " +
            'OR a pre-rendered CFn template (--template <path>).'
        );
      }
      logger.info(synthesisStatusMessage(appCmd, 'Synthesizing CDK app to read template...'));
      const synthesizer = new Synthesizer();
      const context = parseContextOptions(options.context);
      const result = await synthesizer.synthesize({
        app: appCmd,
        output: options.output || 'cdk.out',
        ...(Object.keys(context).length > 0 && { context }),
        // Threaded so the macro-expander has a real state bucket for
        // the > 51,200-byte template upload path (Issue #463).
        stateBucket,
        ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
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
      rootNestedTemplatePaths = stackInfo.nestedTemplates ?? {};
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

    // Guard (issue #1183): a rollback journal means the stack is in a failed,
    // not-yet-reverted state. Exporting that half-deployed state to
    // CloudFormation is almost certainly unintended — warn and require
    // confirmation (or --yes), pointing at `cdkd rollback` / re-deploy first.
    const exportJournal = await stateBackend.loadRollbackJournal(resolvedStackName, targetRegion);
    if (exportJournal && exportJournal.segments.length > 0) {
      logger.warn(
        `Stack '${resolvedStackName}' has a rollback journal — a previous deploy failed or was ` +
          `interrupted and has not been reverted. Exporting this half-deployed state to ` +
          `CloudFormation is likely unintended; run 'cdkd rollback ${resolvedStackName}' to revert ` +
          `(or 'cdkd deploy' to fix forward) first.`
      );
      if (!options.yes && !options.dryRun) {
        const proceed = await confirmPrompt('Export anyway?');
        if (!proceed) {
          logger.info('Export cancelled');
          return;
        }
      }
    }

    // Build the import plan BEFORE acquiring the lock: cdkd state × template
    // resources, classified into phase1 (importable) / phase2 (Custom::* CFn
    // will CREATE) / recreateBeforePhase2 (IMPORT-unsupported, pre-delete +
    // CFn CREATE in phase 2) / nestedStackRows (AWS::CloudFormation::Stack —
    // PR B1 detects, PR B2 submits) / blocked (anything else — aborts).
    //
    // Ordering (issue #1659): planning performs NO AWS write — it reads the
    // already-loaded state object plus `DescribeType` — so nothing here needs
    // the lock, and a stack that cannot be exported at all now says so without
    // first taking a lock that blocks concurrent `cdkd deploy` / `destroy`.
    // The nested-stack path has always planned before locking
    // (`runPerStackImportLoop` acquires per-child locks after its own
    // `buildImportPlan`); this makes the single-stack path agree.
    const { phase1Imports, phase2Creates, recreateBeforePhase2, nestedStackRows, blocked } =
      await buildImportPlan(state, template, awsClients.cloudFormation, resolvedStackName, {
        recreateImportUnsupported: options.recreateImportUnsupported,
        skipImportSupportPreflight: options.skipImportSupportPreflight,
        // Consulted only for a row cdkd state cannot answer for (issue #1791).
        // Same client family as `awsClients.cloudFormation` above, so the
        // region assumption is the one the whole command already makes.
        ec2Client: awsClients.ec2,
      });

    // `blocked` resources are genuinely unfixable (missing state, unknown
    // never-importable types, a type CFn refuses for IMPORT, etc.) — nothing
    // the user can do at runtime resolves them. Hard-fail in both dry-run and
    // real-run paths; printing the plan here is unhelpful because there is no
    // path forward.
    if (blocked.length > 0) {
      logger.error('The following resources block migration:');
      for (const line of groupBlockedReasons(blocked)) {
        logger.error(line);
      }
      throw new Error(
        `${new Set(blocked.map((b) => b.logicalId)).size} resource(s) block migration. ` +
          `Either destroy them first ` +
          `(cdkd destroy / cdkd state destroy cherry-picked), or remove them from the ` +
          `CDK app and re-synthesize.`
      );
    }

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
            `'cdkd force-unlock ${resolvedStackName} --stack-region ${targetRegion}' if you are ` +
            `certain no other process is active.`
        );
      }
    }

    try {
      // Nested-stack rows (issue #464 PR B2): full per-stack IMPORT loop.
      // The orchestrator handles the entire cdkd → CFn migration for the
      // whole tree: leaf-first IMPORT changesets, child-ARN adoption via
      // the AWS-docs "Nest an existing stack" pattern, per-stack phase-2
      // UPDATE for Custom Resources, leaf-first state cleanup, and
      // per-child lock acquisition / release. See `runPerStackImportLoop`
      // for the algorithm + design §4.3 for the AWS-side constraint that
      // ruled out the original single-atomic-changeset design.
      if (nestedStackRows.length > 0) {
        // Pass the already-loaded `state` to skip the redundant
        // root-state fetch — the orchestrator just read it at line ~770.
        const nestedStackTree = await buildCdkdStateStackTree(
          resolvedStackName,
          targetRegion,
          stateBackend,
          state
        );

        // Run the same drift-baseline / cross-stack pre-flight the flat
        // path runs. For nested trees, only the root parent's outputs
        // are visible to sibling stacks (children are accessed via the
        // parent's `Outputs.<ChildLogicalId>` propagation, not directly),
        // so scanning the root is sufficient.
        reportDriftBaselineGaps(state, logger);
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
                  `references depend on the CloudFormation fallback (the migrated stack's ` +
                  `outputs live in CFn; cdkd resolves them via DescribeStacks after the ` +
                  `cdkd-state miss), and consumers deployed with --no-cfn-fallback break. ` +
                  `Migrate consumers first, or remove the references, or drop ` +
                  `--strict-cross-stack to proceed with a warning:\n` +
                  lines.join('\n')
              );
            }
            logger.warn(
              `${crossRefs.length} cross-stack reference(s) to '${resolvedStackName}' from ` +
                `sibling stacks. After the migration those consumers resolve this stack's ` +
                `outputs via the CloudFormation fallback (weak reference; the outputs now ` +
                `live in CFn) — they break only when deployed with --no-cfn-fallback. ` +
                `Migrate consumers from the leaves up if you rely on cdkd-state-only resolution.`
            );
            for (const line of lines) logger.warn(line);
          }
        }

        // Resolve root template Parameters once (forwarded to the root's
        // IMPORT changeset; children's Parameters are extracted per-stack
        // by the orchestrator from the parent's `Properties.Parameters`
        // block).
        const userParametersNested = parseParameterOverrides(options.parameter);
        const { parameters: rootParametersForNested, missing: missingNested } =
          resolveTemplateParameters(template, userParametersNested);
        if (missingNested.length > 0) {
          throw new Error(
            `Template requires parameter(s) without defaults: ${missingNested.join(', ')}. ` +
              `Pass each one as --parameter Key=Value (or set a Default in the CDK code).`
          );
        }

        const childOverrides = parseCfnChildStackNameOverrides(options.cfnChildStackName);
        const result = await runPerStackImportLoop({
          rootStackName: resolvedStackName,
          rootRegion: targetRegion,
          rootStackInfoNestedTemplates: rootNestedTemplatePaths,
          rootTemplateFormat: templateFormat,
          tree: nestedStackTree,
          rootTemplate: template,
          cfnStackNameOverrides: {
            root: options.cfnStackName,
            childMap: childOverrides,
          },
          rootParameters: rootParametersForNested,
          deps: {
            cfnClient: awsClients.cloudFormation,
            ec2Client: awsClients.ec2,
            stateBackend,
            lockManager,
            uploadOpts: {
              stateBucket,
              ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
            },
            lockOwner: owner,
          },
          options: {
            dryRun: options.dryRun,
            yes: options.yes,
            includeNonImportable: options.includeNonImportable,
            recreateImportUnsupported: options.recreateImportUnsupported,
            skipImportSupportPreflight: options.skipImportSupportPreflight,
          },
        });

        if (result.outcome === 'success') {
          // Compute the root's resolved CFn name with the same fallback the
          // orchestrator applied (override → cdkd2cfnStackName(rootName) →
          // identity for `~`-free root names). The outer `cfnStackName`
          // variable was set with the bare `resolvedStackName` fallback
          // (before nested-stack handling was added) so it can diverge
          // from what the orchestrator actually submitted; recompute here
          // so the next-steps banner names the stack the user can find
          // in the CFn console.
          const rootCfnNameForNextSteps =
            options.cfnStackName ?? cdkd2cfnStackName(resolvedStackName);
          printNextSteps({
            cfnStackName: rootCfnNameForNextSteps,
            cdkStackName: resolvedStackName,
            contextOverrides: options.context ?? [],
          });
        }

        // `migrationPending` and `etag` are state-bookkeeping fields the
        // outer scope deliberately references-and-discards (see the same
        // `void` pattern in the flat-stack path below).
        void etag;
        void migrationPending;
        return;
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
      // outputs live in CFn (not cdkd state). Since issue #1697 cdkd's
      // `Fn::GetStackOutput` resolver falls back to CloudFormation
      // `DescribeStacks` on a cdkd-state miss, so consumers keep
      // resolving by default — but the reference becomes
      // CFn-fallback-dependent, and consumers deployed with
      // `--no-cfn-fallback` break. Warn (or refuse with
      // --strict-cross-stack) when any sibling stack in the same CDK app
      // references this one. The scan only sees stacks in
      // `allSynthStacks` — when the user passes --template, we skip the
      // scan because we have no sibling templates.
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
                `references depend on the CloudFormation fallback (the migrated stack's ` +
                `outputs live in CFn; cdkd resolves them via DescribeStacks after the ` +
                `cdkd-state miss), and consumers deployed with --no-cfn-fallback break. ` +
                `Migrate consumers first, or remove the references, or drop ` +
                `--strict-cross-stack to proceed with a warning:\n` +
                lines.join('\n')
            );
          }
          logger.warn(
            `${crossRefs.length} cross-stack reference(s) to '${resolvedStackName}' from ` +
              `sibling stacks. After the migration those consumers resolve this stack's ` +
              `outputs via the CloudFormation fallback (weak reference; the outputs now ` +
              `live in CFn) — they break only when deployed with --no-cfn-fallback. ` +
              `Migrate consumers from the leaves up if you rely on cdkd-state-only resolution.`
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
      // so we inject DeletionPolicy: Delete on resources that lack the
      // attribute — matches what CFn would have applied as the type's
      // default if the user had deployed via plain CFn. See
      // injectDeletionPolicyForImport's docstring for the Retain-vs-Delete
      // rationale.
      const phase1Template = filterTemplateForImport(template, phase1Imports);
      const injectedCount = injectDeletionPolicyForImport(phase1Template);
      if (injectedCount > 0) {
        logger.info(
          `Injected DeletionPolicy: Delete on ${injectedCount} resource(s) without an ` +
            `explicit DeletionPolicy (required by CFn IMPORT — matches the CDK/CFn ` +
            `default for resources without RemovalPolicy).`
        );
      }
      await executeImportChangeSet(
        awsClients.cloudFormation,
        cfnStackName,
        phase1Template,
        phase1Imports,
        cfnParameters,
        templateFormat,
        {
          stateBucket,
          ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
        }
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
          // Apply the same conditional overlay to phase-2 that phase-1
          // applied, preserving symmetry — see
          // applyImportOverlayForPhase2's docstring for the rule (only
          // fires on literal-string mismatch, no-op for absent / intrinsic)
          // and PR #316 for the silent-REPLACE incident that surfaced the
          // symmetry requirement.
          const phase2Template = applyImportOverlayForPhase2(template, phase1Imports);
          await executeUpdateChangeSet(
            awsClients.cloudFormation,
            cfnStackName,
            phase2Template,
            cfnParameters,
            templateFormat,
            {
              stateBucket,
              ...(options.profile && { s3ClientOpts: { profile: options.profile } }),
            }
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

export function parseTemplateFile(path: string): {
  template: Record<string, unknown>;
  format: TemplateFormat;
} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read template file '${path}': ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
  try {
    const { template, format } = parseCfnTemplateWithFormat(raw);
    return { template, format };
  } catch (err) {
    throw new Error(
      `Template file '${path}' is not a valid CloudFormation template. ` +
        `cdkd export accepts JSON and YAML (YAML via a CFn-aware codec that ` +
        `preserves !Ref / !GetAtt / !Sub shorthand). Cause: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
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
 * thought it owned. Nested-stack rows are handled by a dedicated branch
 * in {@link buildImportPlan} (issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1) that routes
 * the row to the cdkd-state-side tree walker. The CFn-side
 * `--include-nested-stacks` IMPORT changeset submission lands in PR B2.
 *
 * Exported for unit testing.
 */
export function isPhase2CreatableType(resourceType: string): boolean {
  return isCustomResourceType(resourceType);
}

/**
 * Recursive tree of cdkd-state stacks rooted at a parent. Mirror of
 * `CfnStackResourceTree` (in `retire-cfn-stack.ts`) for the cdkd-state
 * side: each node carries `(stackName, region, state)` plus `nestedChildren`
 * keyed by the child's `AWS::CloudFormation::Stack` logical id in the
 * parent's state.
 *
 * Built once per `cdkd export` invocation (issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1 + PR B2) so the
 * recursive walk over child state files happens up front, before any
 * AWS-side mutation. Loading the full tree eagerly catches missing-child
 * state inconsistencies before the orchestrator tries to plan-print or
 * submit anything.
 */
export interface CdkdStateStackTree {
  /**
   * For the root: the user-supplied cdkd stack name. For nested children:
   * the v6 state-key stack-name portion `<parent>~<childLogicalId>` (which
   * is what `stateBackend.getState(...)` accepts and what
   * `stateBackend.deleteState(...)` will reap during PR B2's state-cleanup
   * pass).
   */
  stackName: string;
  /**
   * Region of the state record. All children inherit the parent's region
   * today — AWS does not support cross-region nested stacks. The explicit
   * field is kept per the v6 schema design so a future cross-region
   * capability does not require another tree-shape bump.
   */
  region: string;
  /** The loaded state record for this node. */
  state: StackState;
  /** `childLogicalId → child tree node` for every direct nested child. Empty when the node has no nested children. */
  nestedChildren: Map<string, CdkdStateStackTree>;
}

/**
 * Recursively load the cdkd-state tree rooted at `(rootStackName, region)`.
 * For every `AWS::CloudFormation::Stack` row in each level's
 * `state.resources`, derives the child's v6 state key
 * (`<parent>~<childLogicalId>`) and loads the child state file from S3,
 * then recurses.
 *
 * Throws if any expected child state file is missing — the parent's state
 * lists a nested-stack row but the child's `cdkd/<parent>~<child>/<region>/state.json`
 * does not exist. That state-tree inconsistency must be resolved before
 * any export attempt (typically via `cdkd state orphan <parent>` and a
 * full re-deploy, or by completing whatever partial operation left the
 * tree torn).
 *
 * Children at each level are loaded sequentially today (not `Promise.all`)
 * because the failure-mode shape is "fail fast on the first missing
 * child" rather than "list every missing child" — a single missing-child
 * pointer is enough for the user to identify the root cause without
 * fanning out N parallel `getState` calls on a torn tree. PR B2 may
 * revisit this once the per-child template-fetch / preprocessing /
 * upload pass dominates the wall-clock cost.
 *
 * Exported so the walker can be unit-tested independently of the orchestrator.
 *
 * Callers that already loaded the root state record up front (the typical
 * orchestrator shape — `exportCommand` always reads it via
 * `stateBackend.getState` before plan-build) can pass it via the optional
 * `prefetchedRootState` argument to save one S3 round-trip per export run.
 * Otherwise the walker fetches it itself, matching the standalone-use
 * signature.
 */
export async function buildCdkdStateStackTree(
  rootStackName: string,
  region: string,
  stateBackend: S3StateBackend,
  prefetchedRootState?: StackState
): Promise<CdkdStateStackTree> {
  let rootState: StackState;
  if (prefetchedRootState !== undefined) {
    rootState = prefetchedRootState;
  } else {
    const rootResult = await stateBackend.getState(rootStackName, region);
    if (!rootResult) {
      throw new Error(
        `No cdkd state found for stack '${rootStackName}' (${region}). ` +
          `Cannot build nested-stack tree.`
      );
    }
    rootState = rootResult.state;
  }
  return walkCdkdStateStackTree(rootStackName, region, rootState, stateBackend);
}

async function walkCdkdStateStackTree(
  stackName: string,
  region: string,
  state: StackState,
  stateBackend: S3StateBackend
): Promise<CdkdStateStackTree> {
  const nestedChildren = new Map<string, CdkdStateStackTree>();
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    if (resource.resourceType !== NESTED_STACK_RESOURCE_TYPE) continue;
    const childStackName = `${stackName}~${logicalId}`;
    const childResult = await stateBackend.getState(childStackName, region);
    if (!childResult) {
      throw new Error(
        `cdkd state is missing nested-child '${childStackName}' (${region}). ` +
          `Parent stack '${stackName}' lists '${logicalId}' as an ` +
          `${NESTED_STACK_RESOURCE_TYPE} row but no child state file exists at ` +
          `'cdkd/${childStackName}/${region}/state.json'. The cdkd state tree is ` +
          `inconsistent — re-deploy the parent stack to refresh, or run ` +
          `'cdkd state orphan ${stackName}' and re-import.`
      );
    }
    // Sanity-check the child's recorded region against the walker's
    // expected region (the parent's region). AWS does not support
    // cross-region nested stacks today — design §6 — so a mismatch
    // is either a torn state file (manually edited) or a future
    // cross-region capability landing without a tree-shape bump. Fail
    // fast in either case so the orchestrator does not silently
    // proceed against a parent ↔ child pair whose AWS-side identity
    // we cannot guarantee.
    if (childResult.state.region !== undefined && childResult.state.region !== region) {
      throw new Error(
        `cdkd state region mismatch: nested-child '${childStackName}' has ` +
          `state.region='${childResult.state.region}' but its parent '${stackName}' ` +
          `is being walked against region='${region}'. AWS does not support ` +
          `cross-region nested stacks; the state tree appears corrupt — ` +
          `re-deploy the parent stack to refresh.`
      );
    }
    nestedChildren.set(
      logicalId,
      await walkCdkdStateStackTree(childStackName, region, childResult.state, stateBackend)
    );
  }
  return { stackName, region, state, nestedChildren };
}

/**
 * Flatten a {@link CdkdStateStackTree} into a depth-first list of
 * `(stackName, region)` pairs in **leaf-first** order — same order PR B2's
 * state-cleanup pass will use to delete each adopted stack's cdkd state
 * after the CFn-side IMPORT succeeds (so a mid-walk failure leaves the
 * earlier parent's state intact for retry).
 *
 * Exported so callers (orchestrator user-facing summary, unit tests) can
 * iterate the tree in the same order without re-implementing the walk.
 */
export function flattenCdkdStateTreeLeafFirst(
  tree: CdkdStateStackTree
): Array<{ stackName: string; region: string }> {
  const out: Array<{ stackName: string; region: string }> = [];
  walk(tree);
  return out;

  function walk(node: CdkdStateStackTree): void {
    for (const child of node.nestedChildren.values()) {
      walk(child);
    }
    out.push({ stackName: node.stackName, region: node.region });
  }
}

/**
 * Flatten a {@link CdkdStateStackTree} into a depth-first list of
 * `(stackName, region)` pairs in **root-first** order — the inverse of
 * {@link flattenCdkdStateTreeLeafFirst}. Used by the parameter-resolution
 * pre-pass in `runPerStackImportLoop` (issue #464 follow-up): each child's
 * intrinsic-valued Parameters resolve against its parent's already-resolved
 * Parameters, so the parent must be visited first.
 *
 * Exported so callers (orchestrator parameter pre-pass, unit tests) can
 * iterate the tree in the same order without re-implementing the walk.
 */
export function flattenCdkdStateTreeRootFirst(
  tree: CdkdStateStackTree
): Array<{ stackName: string; region: string }> {
  const out: Array<{ stackName: string; region: string }> = [];
  walk(tree);
  return out;

  function walk(node: CdkdStateStackTree): void {
    out.push({ stackName: node.stackName, region: node.region });
    for (const child of node.nestedChildren.values()) {
      walk(child);
    }
  }
}

/**
 * Map a cdkd stack name to a CloudFormation-compatible stack name.
 *
 * Required because the cdkd v6 state-key form `<parent>~<childLogicalId>`
 * contains `~`, which CFn rejects in stack names (CFn accepts
 * `[a-zA-Z][-a-zA-Z0-9]*` only). The substitution chooses `-` to mirror
 * CFn's own auto-naming convention for nested stacks
 * (`<Parent>-<ChildLogicalId>-<RandomSuffix>` minus the suffix).
 *
 * Top-level cdkd stack names that already conform to CFn's character set
 * are passed through unchanged — `cdkd2cfnStackName('MyApp') === 'MyApp'`.
 *
 * The post-substitution result is validated against the same CFn
 * stack-name regex `parseCfnChildStackNameOverrides` enforces
 * (`[a-zA-Z][-a-zA-Z0-9]*`). The `~` → `-` swap only handles the v6
 * separator; a cdkd name that is otherwise CFn-illegal (leading digit /
 * underscore, embedded `.` or `/`, etc.) would still pass through and
 * surface as an opaque CFn API rejection deep inside the IMPORT loop.
 * Throwing here surfaces the problem at orchestrator pre-flight time with
 * an actionable pointer at the `--cfn-stack-name` / `--cfn-child-stack-name`
 * override escape hatch.
 *
 * Issue #464 design §9 Q8.
 */
export function cdkd2cfnStackName(cdkdStackName: string): string {
  const cfnName = cdkdStackName.replace(/~/g, '-');
  if (!/^[a-zA-Z][-a-zA-Z0-9]*$/.test(cfnName)) {
    throw new Error(
      `cdkd stack name '${cdkdStackName}' maps to CFn stack name '${cfnName}', which violates ` +
        `the CloudFormation stack-name constraint [a-zA-Z][-a-zA-Z0-9]* (must start with a ` +
        `letter; no '_', '.', '/', or other special characters). Supply an explicit name via ` +
        `--cfn-stack-name (root) or --cfn-child-stack-name '<cdkdName>=<cfnName>' (nested child).`
    );
  }
  return cfnName;
}

/**
 * Parse the repeatable `--cfn-child-stack-name <cdkdName>=<cfnName>` CLI
 * flag into a lookup map. Each entry maps a cdkd stack name (v6 form,
 * e.g. `MyApp~Database`) to the desired CFn stack name.
 *
 * Throws on a malformed entry (no `=`, empty cdkdName, empty cfnName, or
 * a CFn name that violates the CFn naming constraint) so the user sees
 * the problem before any AWS-side mutation. Duplicate cdkdName keys are
 * rejected to avoid silent last-wins behavior.
 *
 * Exported for unit testing.
 */
export function parseCfnChildStackNameOverrides(values: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!values || values.length === 0) return out;
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq < 0) {
      throw new Error(
        `--cfn-child-stack-name '${raw}' is not in <cdkdName>=<cfnName> form. ` +
          `Example: --cfn-child-stack-name 'MyApp~Database=my-app-database'.`
      );
    }
    const cdkdName = raw.slice(0, eq).trim();
    const cfnName = raw.slice(eq + 1).trim();
    if (!cdkdName) {
      throw new Error(`--cfn-child-stack-name '${raw}' has an empty cdkd stack name.`);
    }
    if (!cfnName) {
      throw new Error(`--cfn-child-stack-name '${raw}' has an empty CFn stack name.`);
    }
    if (!/^[a-zA-Z][-a-zA-Z0-9]*$/.test(cfnName)) {
      throw new Error(
        `--cfn-child-stack-name '${raw}': CFn stack name '${cfnName}' must match ` +
          `[a-zA-Z][-a-zA-Z0-9]* (no '~', no '/', no '_', no '.').`
      );
    }
    if (out.has(cdkdName)) {
      throw new Error(
        `--cfn-child-stack-name: duplicate override for cdkd stack '${cdkdName}'. ` +
          `Pass it once with the final CFn name.`
      );
    }
    out.set(cdkdName, cfnName);
  }
  return out;
}

/**
 * Read + parse a nested-stack child template from the synth cloud assembly.
 * The path is the absolute filesystem path AssemblyReader populated from
 * the parent template's `Metadata['aws:asset:path']` on each
 * `AWS::CloudFormation::Stack` resource.
 *
 * Format-aware: CDK 2.x always synthesizes JSON for nested templates, but
 * the codec recognizes both JSON and YAML so the helper is forward-compatible
 * with any synth output (and matches `parseTemplateFile` for `--template`).
 *
 * Sibling of `readNestedChildTemplate` in `import.ts`. Kept separate so
 * `export.ts` does not depend on `import.ts` internals and the return
 * shape (`Record<string, unknown>` + `TemplateFormat`) matches what
 * `executeImportChangeSet` / `executeUpdateChangeSet` consume. Consolidate
 * into a shared `nested-template-fs.ts` module if a third caller appears.
 */
function readNestedChildTemplateFile(
  templatePath: string,
  childLogicalId: string
): { template: Record<string, unknown>; format: TemplateFormat } {
  let raw: string;
  try {
    raw = readFileSync(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `cdkd export: failed to read nested-stack template for '${childLogicalId}' at ` +
        `'${templatePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    return parseCfnTemplateWithFormat(raw);
  } catch (err) {
    throw new Error(
      `cdkd export: failed to parse nested-stack template for '${childLogicalId}' at ` +
        `'${templatePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Index every `AWS::CloudFormation::Stack` row in `template` by its
 * `Metadata['aws:asset:path']`, returning `{logicalId: <absolute-path>}`.
 * Mirrors `AssemblyReader.extractStackInfo`'s nested-template indexing
 * (line ~277 of `assembly-reader.ts`) so the same logic applies to
 * arbitrary depth — grandchild templates are siblings of their parent
 * child template in the same cdk.out subdirectory.
 *
 * Refuses absolute `aws:asset:path` values (CDK emits relative paths
 * only; an absolute path indicates hand-modified synth output or a
 * non-CDK toolchain — `path.join(dir, '/abs/foo')` would silently bypass
 * the `dir` argument).
 *
 * Sibling of `indexGrandchildTemplatePaths` in `import.ts`. Same rationale
 * for separate definitions as `readNestedChildTemplateFile` above.
 */
function indexNestedTemplatePaths(
  template: Record<string, unknown>,
  templateDir: string
): Record<string, string> {
  const result: Record<string, string> = {};
  const resources = template['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return result;
  for (const [logicalId, resource] of Object.entries(resources as Record<string, unknown>)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as { Type?: string; Metadata?: Record<string, unknown> };
    if (r.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const assetPath = r.Metadata?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    if (nodePath.isAbsolute(assetPath)) {
      throw new Error(
        `cdkd export: nested-stack '${logicalId}' has Metadata['aws:asset:path']='${assetPath}' ` +
          `which is absolute. CDK emits relative asset paths for nested templates.`
      );
    }
    result[logicalId] = nodePath.join(templateDir, assetPath);
  }
  return result;
}

/**
 * Per-stack metadata required by {@link runPerStackImportLoop}: the cdkd
 * stack name, region, loaded state, parsed template, and template format.
 * One entry per node in the {@link CdkdStateStackTree}.
 */
export interface PerStackImportNode {
  cdkdStackName: string;
  region: string;
  state: StackState;
  template: Record<string, unknown>;
  templateFormat: TemplateFormat;
}

/**
 * Walk the cdkd state tree alongside the synth output's nested-template
 * file paths, materializing each node's parsed template + format. The
 * walker indexes children's paths from the parent template's
 * `Metadata['aws:asset:path']` (same mechanism `AssemblyReader` uses for
 * the root parent), so grandchildren and deeper levels are loaded
 * recursively without any caller-side index plumbing.
 *
 * Throws if any tree node has a child whose template path is missing from
 * the parent template's nested-template index — that mismatch indicates
 * a torn synth output (the child state file exists but the parent CDK
 * code no longer references it) and the run cannot proceed safely.
 *
 * Returns a map keyed by cdkd stack name (matching tree node names) so
 * {@link runPerStackImportLoop} can look each node's template up by name
 * without re-traversing the tree.
 *
 * Exported so the recursion shape is unit-testable independently of the
 * orchestrator.
 */
export function buildPerStackImportNodes(
  rootStackName: string,
  rootTemplate: Record<string, unknown>,
  rootNestedTemplatePaths: Record<string, string>,
  rootTemplateFormat: TemplateFormat,
  tree: CdkdStateStackTree
): Map<string, PerStackImportNode> {
  if (tree.stackName !== rootStackName) {
    throw new Error(
      `buildPerStackImportNodes: tree root '${tree.stackName}' does not match ` +
        `expected root stack name '${rootStackName}'.`
    );
  }
  const out = new Map<string, PerStackImportNode>();
  walk(tree, rootTemplate, rootNestedTemplatePaths, rootTemplateFormat);
  return out;

  function walk(
    node: CdkdStateStackTree,
    nodeTemplate: Record<string, unknown>,
    nodeNestedTemplatePaths: Record<string, string>,
    nodeFormat: TemplateFormat
  ): void {
    out.set(node.stackName, {
      cdkdStackName: node.stackName,
      region: node.region,
      state: node.state,
      template: nodeTemplate,
      templateFormat: nodeFormat,
    });
    for (const [childLogicalId, childNode] of node.nestedChildren) {
      const childTemplatePath = nodeNestedTemplatePaths[childLogicalId];
      if (!childTemplatePath) {
        throw new Error(
          `cdkd export: nested-stack child '${childLogicalId}' under parent ` +
            `'${node.stackName}' has cdkd state but no Metadata['aws:asset:path'] ` +
            `in the parent template's '${childLogicalId}' row. The synth output ` +
            `and the cdkd state tree are out of sync — re-deploy the parent stack ` +
            `to refresh, or remove the cdkd state for the orphaned child via ` +
            `'cdkd state orphan ${childNode.stackName}'.`
        );
      }
      const { template: childTemplate, format: childFormat } = readNestedChildTemplateFile(
        childTemplatePath,
        childLogicalId
      );
      const childNestedPaths = indexNestedTemplatePaths(
        childTemplate,
        nodePath.dirname(childTemplatePath)
      );
      walk(childNode, childTemplate, childNestedPaths, childFormat);
    }
  }
}

/**
 * A nested-stack row detected in the parent template + matched against the
 * parent's cdkd state. Surfaced by {@link buildImportPlan} so the
 * orchestrator can route the row through the recursive nested-stack
 * tree walker (issue [#464](https://github.com/go-to-k/cdkd/issues/464)
 * PR B1 + PR B2) instead of the per-resource IMPORT path.
 *
 * Holds only the parent-side row identifiers; the child's full state /
 * sub-template / further descendants are loaded separately by
 * {@link buildCdkdStateStackTree}. Keeping the two passes separate means
 * `buildImportPlan` stays pure (no state-backend I/O) and the tree walker
 * stays focused on the recursive load.
 */
export interface NestedStackRow {
  /** Logical id of the `AWS::CloudFormation::Stack` row in the parent's template. */
  logicalId: string;
  /**
   * The v6 child state-key's stack-name portion: `<parent>~<childLogicalId>`.
   * Derived deterministically from `(parentStackName, logicalId)` so the
   * orchestrator can quote it in user-facing error messages without
   * round-tripping through {@link buildCdkdStateStackTree}.
   */
  childStackName: string;
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
 *   - `nestedStackRows`: `AWS::CloudFormation::Stack` rows in the parent
 *     template. Surfaced separately because they are handled by the
 *     nested-stack tree walker, not the per-resource IMPORT path
 *     (issue [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1 + PR B2).
 *     The orchestrator currently hard-errors when any are present —
 *     CFn-side `--include-nested-stacks` IMPORT changeset submission
 *     lands in PR B2.
 *   - `blocked`: anything else. A non-empty `blocked` aborts the run.
 */
export async function buildImportPlan(
  state: StackState,
  template: Record<string, unknown>,
  cfnClient: AwsClients['cloudFormation'],
  parentStackName: string,
  options: {
    recreateImportUnsupported: boolean;
    skipImportSupportPreflight?: boolean;
    /**
     * Live-read seam for the identifier BACKFILL (issue
     * [#1791](https://github.com/go-to-k/cdkd/issues/1791)). Optional so a
     * caller with no EC2 client keeps the pre-#1791 state-only behavior
     * verbatim; the real command path always supplies it, and it is consulted
     * ONLY for a row whose state could not answer — see
     * {@link resolveIdentifierValue}.
     */
    ec2Client?: EC2Client;
  } = {
    recreateImportUnsupported: true,
  }
): Promise<{
  phase1Imports: ImportPlanEntry[];
  phase2Creates: Phase2CreateEntry[];
  recreateBeforePhase2: RecreateBeforePhase2Entry[];
  nestedStackRows: NestedStackRow[];
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
  const nestedStackRows: NestedStackRow[] = [];
  const blocked: BlockedResource[] = [];
  const identifierCache = new Map<string, PrimaryIdentifierCacheEntry>();
  // Built ONCE per call, not per row: it carries the per-group
  // DescribeSecurityGroupRules memo, so a per-row object would walk the same
  // security group again for every rule sitting on it. Per CALL and not
  // module-global for the reason the field's own docs give — a `--concurrency`
  // run exports several stacks through separate invocations of this function.
  const backfillDeps = options.ec2Client
    ? createIdentifierBackfillDeps(options.ec2Client)
    : undefined;

  for (const [logicalId, raw] of Object.entries(templateResources as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const resource = raw as { Type?: string };
    const resourceType = resource.Type ?? '';
    if (!resourceType) continue;

    if (resourceType === 'AWS::CDK::Metadata') {
      // CDK sentinel — silently dropped. Not a real AWS resource.
      continue;
    }

    if (resourceType === NESTED_STACK_RESOURCE_TYPE) {
      // Nested-stack row. Dedicated branch instead of the per-resource
      // IMPORT path: the AWS-side child stack is adopted via CFn IMPORT's
      // `--include-nested-stacks` flag (PR B2), not via cdkd's
      // resource-identifier resolution. Validate the parent state has a
      // matching row (parent's nested-stack entry carries the cdkd-local
      // synthesized ARN; absence means the cdkd state tree is missing
      // the parent → child link).
      const parentRow = state.resources[logicalId];
      if (!parentRow || parentRow.resourceType !== NESTED_STACK_RESOURCE_TYPE) {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `template has AWS::CloudFormation::Stack row '${logicalId}' but cdkd state has no ` +
            `matching nested-stack entry on parent '${parentStackName}'. ` +
            `Re-deploy or re-import the parent stack to refresh state.`,
        });
        continue;
      }
      nestedStackRows.push({
        logicalId,
        childStackName: `${parentStackName}~${logicalId}`,
      });
      continue;
    }

    if (isNeverImportableType(resourceType)) {
      if (isPhase2CreatableType(resourceType)) {
        // Custom::* — CFn will CREATE fresh in phase 2.
        phase2Creates.push({ logicalId, resourceType });
      } else {
        // AWS::CDK::Metadata is already short-circuited above; reaching
        // this branch means a future type was added to NEVER_IMPORTABLE_TYPES
        // without phase-2 support. Hard block with a clear pointer so the
        // failure is debuggable.
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

    // Pre-flight: CloudFormation refuses the whole IMPORT changeset for a type
    // with no `read` handler, so surface it here — before the phase-1 template
    // preprocessing and the user confirmation, and naming EVERY offender at
    // once. AWS's own error is not exhaustive: a probe carrying three
    // unsupported types named two of them, and a two-type probe named one
    // (measured us-east-1, 2026-08-13), so deferring to CreateChangeSet hands
    // the user a fix-one-rerun loop.
    //
    // Deliberately AFTER the IMPORT_UNSUPPORTED_RECREATABLE_TYPES branch
    // above, because cdkd has a real answer (pre-delete + phase-2 CREATE) for
    // the types on that list and must not steal them. `AWS::IAM::Policy` would
    // otherwise land here: it is NON_PROVISIONABLE with no `read` handler.
    // `AWS::ApiGatewayV2::Stage` would NOT — measured live us-east-1
    // 2026-08-13 it is now FULLY_MUTABLE with a full handler set including
    // `read`, so the registry no longer agrees with the reason that type was
    // put on the recreatable list. Whether its pre-delete + re-CREATE dance
    // (and its unavailability window) is still necessary is tracked separately;
    // this ordering keeps today's behavior either way (issue
    // [#1772](https://github.com/go-to-k/cdkd/issues/1772)).
    let resolved: CompositeIdResult;
    try {
      // ONE `DescribeType` per type answers both questions — the pre-flight
      // above and the identifier resolution below share `identifierCache`, and
      // `resolveResourceIdentifier` takes the entry rather than re-fetching it.
      // A failure here means no usable schema AND no fallback entry, which the
      // catch reports with `fetchPrimaryIdentifier`'s own remediation message.
      const schemaInfo = await cachedTypeSchemaInfo(resourceType, cfnClient, identifierCache);
      if (!options.skipImportSupportPreflight && typeIsImportUnsupported(schemaInfo)) {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `AWS CloudFormation does not support ${resourceType} in IMPORT changesets: its ` +
            `CloudFormation registry schema declares no 'read' handler (and reports the type as ` +
            `NON_PROVISIONABLE), and IMPORT needs that handler to look the resource up by ` +
            `identifier. CreateChangeSet would reject the whole export ` +
            `with "ResourceTypes [${resourceType}] are not supported for Import". Remove the ` +
            `resource from the stack before exporting (it stays in AWS and can be re-declared in ` +
            `CloudFormation afterwards), or destroy it first and let CloudFormation create it ` +
            `fresh. If AWS has since added IMPORT support for this type, please open a cdkd issue.`,
        });
        continue;
      }
      resolved = await resolveResourceIdentifier(
        resourceType,
        logicalId,
        stateEntry.physicalId,
        stateEntry.properties ?? {},
        stateEntry.attributes ?? {},
        schemaInfo,
        backfillDeps
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

    const propertiesOverlay = resolved.propertiesOverlay ?? resolved.resourceIdentifier;

    // Pre-flight the OVERLAY, not just the identifier (issue #1787). See
    // `unrepresentableOverlayFields` for why this cannot live at the overlay
    // site: `--dry-run` returns before any overlay call, and the nested path
    // overlays inside the per-stack IMPORT loop, where a throw would abort with
    // earlier stacks already migrated. Reported through `blocked` so every
    // offender is named in ONE pass, like every other unfixable-resource
    // verdict here.
    const unrepresentable = unrepresentableOverlayFields(raw, propertiesOverlay);
    if (unrepresentable.length > 0) {
      for (const u of unrepresentable) {
        blocked.push({
          logicalId,
          resourceType,
          reason: unrepresentableOverlayMessage(
            { logicalId, resourceType },
            u.field,
            u.current,
            u.value
          ),
        });
      }
      continue;
    }

    phase1Imports.push({
      logicalId,
      resourceType,
      physicalId: stateEntry.physicalId,
      resourceIdentifier: resolved.resourceIdentifier,
      propertiesOverlay,
    });
  }

  return { phase1Imports, phase2Creates, recreateBeforePhase2, nestedStackRows, blocked };
}

/**
 * Render the `blocked` list one bullet per RESOURCE, folding a resource's
 * several reasons into it.
 *
 * The pre-flight pushes one entry per offending FIELD (issue #1787), so a
 * multi-field overlay such as `AWS::S3Tables::Namespace` contributes two rows
 * for one resource — which made the count ("1 resource(s)") disagree with the
 * bullets printed under it. Grouping keeps the two consistent without losing a
 * reason.
 */
export function groupBlockedReasons(blocked: readonly BlockedResource[]): string[] {
  const byResource = new Map<string, { resourceType: string; reasons: string[] }>();
  for (const b of blocked) {
    const entry = byResource.get(b.logicalId) ?? { resourceType: b.resourceType, reasons: [] };
    entry.reasons.push(b.reason);
    byResource.set(b.logicalId, entry);
  }
  return [...byResource].map(([logicalId, { resourceType, reasons }]) =>
    reasons.length === 1
      ? `  - ${logicalId} (${resourceType}): ${reasons[0]}`
      : `  - ${logicalId} (${resourceType}):\n${reasons.map((r) => `      - ${r}`).join('\n')}`
  );
}

/**
 * Per-type cached registry-schema facts from `cloudformation:DescribeType`.
 * The cache key is the resource type.
 *
 * `fields` is the `primaryIdentifier` field-name list (length 1 for single-key
 * types, length > 1 for composites).
 *
 * `importSupport` records what `DescribeType` says about the type's
 * eligibility for a CFn IMPORT changeset (see {@link typeIsImportUnsupported}):
 * - `importable` — the schema declares a `read` handler, which IMPORT needs.
 * - `unsupported` — no `read` handler AND `ProvisioningType:
 *   NON_PROVISIONABLE`. Two independent fields must positively agree before
 *   cdkd refuses.
 * - `unknown` — anything else, including the `PRIMARY_IDENTIFIER_FALLBACK`
 *   path when DescribeType is unusable. Never blocks: a permissions gap, a
 *   throttle, or a partial response must not be read as "AWS cannot import
 *   this" — those keep the pre-existing behavior of letting CreateChangeSet
 *   answer.
 */
type PrimaryIdentifierCacheEntry = {
  fields: string[];
  importSupport: 'importable' | 'unsupported' | 'unknown';
};

/**
 * Build the `ResourceIdentifier` map CloudFormation IMPORT expects in
 * `ResourcesToImport[].ResourceIdentifier` for the given resource type
 * and cdkd state's physical ID.
 *
 * Types whose cdkd physicalId is COMPOSITE while the CFn identifier is a
 * single field (`COMPOSITE_PHYSICAL_ID_IDENTIFIERS`): resolved from cdkd
 * state's recorded attributes, BEFORE the field-count branch below — the
 * physicalId is neither the identifier nor a source to split (issue #1659).
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
 * `entry` is the caller's already-resolved registry-schema info — see
 * {@link cachedTypeSchemaInfo}, which prefers `DescribeType` (the authoritative
 * AWS-internal registry) and falls back to a hardcoded single-key table when
 * DescribeType fails (insufficient permissions, throttling, obscure type
 * without a registry entry). Taking it as a parameter rather than fetching is
 * what keeps `buildImportPlan` to ONE DescribeType per type across both the
 * IMPORT pre-flight and this resolution.
 */
async function resolveResourceIdentifier(
  resourceType: string,
  logicalId: string,
  physicalId: string,
  properties: Record<string, unknown>,
  attributes: Record<string, unknown>,
  entry: PrimaryIdentifierCacheEntry,
  backfillDeps: IdentifierBackfillDeps | undefined
): Promise<CompositeIdResult> {
  // Consulted on BOTH branches (i.e. before either can run): "cdkd's id is
  // composite" and "the CFn identifier is multi-field" are independent facts,
  // and conflating them is the #1659 defect.
  const compositeIdentifier = Object.hasOwn(COMPOSITE_PHYSICAL_ID_IDENTIFIERS, resourceType)
    ? COMPOSITE_PHYSICAL_ID_IDENTIFIERS[resourceType]
    : undefined;
  if (compositeIdentifier) {
    if (entry.fields.length !== 1 || entry.fields[0] !== compositeIdentifier.field) {
      throw new Error(
        `${resourceType} is registered in COMPOSITE_PHYSICAL_ID_IDENTIFIERS as identified by ` +
          `'${compositeIdentifier.field}', but CloudFormation now reports primaryIdentifier ` +
          `[${entry.fields.join(', ')}]. The registry schema changed under cdkd — update the ` +
          `entry in src/cli/commands/export.ts (or move the type to COMPOSITE_ID_SPLITTERS if ` +
          `its identifier is now composite too)`
      );
    }
    const value = await resolveIdentifierValue(
      compositeIdentifier,
      { logicalId, physicalId, attributes },
      backfillDeps
    );
    return {
      resourceIdentifier: { [compositeIdentifier.field]: value },
      // Every registered field is `readOnlyProperties` (live DescribeType,
      // us-east-1, 2026-08-13), so NOTHING may be overlaid onto the synth
      // template's Properties — CFn rejects a read-only property write at
      // changeset-create. An explicit empty map instead of relying on the
      // overlay site's "only writes a field the template already carries"
      // conditional, same as the splitter family's narrowing.
      propertiesOverlay: {},
    };
  }

  if (entry.fields.length === 1) {
    // Single-key path: the physicalId IS the identifier value.
    const map = { [entry.fields[0]!]: physicalId };
    return { resourceIdentifier: map };
  }

  // Composite path: consult the per-type splitter.
  const splitter = Object.hasOwn(COMPOSITE_ID_SPLITTERS, resourceType)
    ? COMPOSITE_ID_SPLITTERS[resourceType]
    : undefined;
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
 * Cache-consulting wrapper around {@link fetchPrimaryIdentifier}. Shared by
 * `resolveResourceIdentifier` and `buildImportPlan`'s pre-flight so one
 * DescribeType per type answers both questions.
 */
async function cachedTypeSchemaInfo(
  resourceType: string,
  cfnClient: AwsClients['cloudFormation'],
  cache: Map<string, PrimaryIdentifierCacheEntry>
): Promise<PrimaryIdentifierCacheEntry> {
  const cached = cache.get(resourceType);
  if (cached !== undefined) return cached;
  const entry = await fetchPrimaryIdentifier(resourceType, cfnClient);
  cache.set(resourceType, entry);
  return entry;
}

/**
 * True when the registry schema says CloudFormation will refuse the type in an
 * IMPORT changeset (`ValidationError: ResourceTypes [<T>] are not supported
 * for Import`) — IMPORT looks the resource up by identifier through the type's
 * `read` handler, so a type without one cannot be adopted.
 *
 * Live-measured (us-east-1, 2026-08-13) against `CreateChangeSet
 * --change-set-type IMPORT`: `AWS::Glue::Table` / `AWS::Route53::RecordSet` /
 * `AWS::AppSync::ApiKey` / `AWS::EC2::NetworkAclEntry` /
 * `AWS::Route53::RecordSetGroup` / `AWS::SQS::QueuePolicy` /
 * `AWS::SNS::TopicPolicy` all lack a `read` handler, are all
 * `NON_PROVISIONABLE`, and were all rejected; `AWS::S3::Bucket`
 * (`FULLY_MUTABLE`, read handler present) passed the type check. Both shapes
 * of "no read handler" occur and both count: NO `handlers` block at all (the
 * legacy types) and a `handlers` block whose keys are only create / update /
 * delete (`AWS::EC2::NetworkAclEntry`).
 *
 * **Why the verdict needs TWO agreeing fields.** Reading "the `handlers` key is
 * missing" as a refusal on its own makes any partial or unusual response block
 * an export that works today — the one regression this pre-flight could cause,
 * and strictly worse than the status quo of letting AWS answer. So the refusal
 * also requires `ProvisioningType: NON_PROVISIONABLE`; a response satisfying
 * only one of the two resolves to `unknown` and is left to CreateChangeSet.
 *
 * The two were perfectly CORRELATED across the 21 types sampled on 2026-08-13
 * (every no-read-handler type was NON_PROVISIONABLE and vice versa), so on
 * today's registry the conjunction's real work is requiring a COMPLETE
 * DescribeType response before refusing. The `read` handler stays the primary
 * signal because it is the mechanistic reason CFn accepts a type for IMPORT —
 * refusing on `ProvisioningType` alone would reject a NON_PROVISIONABLE type
 * that does declare one, should AWS ever publish that combination.
 */
function typeIsImportUnsupported(entry: PrimaryIdentifierCacheEntry): boolean {
  return entry.importSupport === 'unsupported';
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
    // Throttle-shaped DescribeType failures retry with backoff (issue #1236
    // follow-up) instead of instantly degrading to the hardcoded fallback
    // table — a type absent from the table would otherwise abort the export
    // on a transient throttle.
    const resp = await describeTypeWithThrottleRetry(resourceType, cfnClient);
    if (resp.Schema) {
      const parsed = JSON.parse(resp.Schema) as {
        primaryIdentifier?: unknown;
        handlers?: unknown;
      };
      const primary = parsed.primaryIdentifier;
      if (
        Array.isArray(primary) &&
        primary.length > 0 &&
        primary.every((p) => typeof p === 'string')
      ) {
        // Schema entries look like "/properties/BucketName" — strip the
        // JSON-pointer prefix to get the property name.
        const fields = primary.map((p) => p.replace(/^\/properties\//, ''));
        // A missing `handlers` block is how the legacy types (Glue::Table,
        // Route53::RecordSet, AppSync::ApiKey) render, so its absence is
        // meaningful — but only in combination with NON_PROVISIONABLE, per
        // `typeIsImportUnsupported`'s two-agreeing-fields rule.
        // The `!== null` is load-bearing (`hasOwnProperty.call(null, …)`
        // throws, and `typeof null === 'object'`). An `Array.isArray` clause
        // was removed as dead: a JSON-parsed array carries only index keys, so
        // `hasOwnProperty(…, 'read')` already answers false for the `handlers:
        // []` legacy render — a mutation probe confirmed no fixture could
        // distinguish it, and both shapes are covered by tests.
        const handlers = parsed.handlers;
        const hasRead =
          typeof handlers === 'object' &&
          handlers !== null &&
          Object.prototype.hasOwnProperty.call(handlers, 'read');
        const importSupport = hasRead
          ? 'importable'
          : resp.ProvisioningType === 'NON_PROVISIONABLE'
            ? 'unsupported'
            : 'unknown';
        return { fields, importSupport };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().debug(`DescribeType failed for ${resourceType}: ${msg} — using fallback`);
  }

  const fallback = PRIMARY_IDENTIFIER_FALLBACK[resourceType];
  if (fallback) {
    // The fallback table carries identifier names only — nothing is known
    // about handlers here, so the IMPORT pre-flight must not fire.
    return { fields: [fallback], importSupport: 'unknown' };
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
 * attribute get `DeletionPolicy: Delete` injected.
 *
 * Required by CloudFormation `ChangeSetType=IMPORT`, which rejects the
 * changeset if any resource in the template lacks `DeletionPolicy`.
 * CDK-synth templates only emit the attribute when the user sets
 * `RemovalPolicy` explicitly, so most resources are missing it.
 *
 * **Why `Delete` (not `Retain`)**: a CDK resource without explicit
 * `RemovalPolicy` defaults to `Delete` at CFn level (the type-default
 * delete behavior). Injecting `Delete` matches that intent verbatim —
 * the user is saying "treat this like the AWS default" and cdkd does
 * exactly that. Injecting `Retain` would be an opinionated override
 * that surprises users (their CFn template suddenly has a `Retain` they
 * never asked for) and adds a "transient injection" concept to the
 * mental model.
 *
 * The narrow scenario where `Retain` would help (cdkd export's phase-2
 * fails AND the user picks `delete-stack` as the recovery path) is not
 * unique to cdkd export and is not the documented recovery path (the
 * phase-2-failure error message walks the user through a manual
 * UpdateStack retry instead). The asymmetric-risk argument doesn't
 * justify the UX cost of the "transient Retain" mental model.
 *
 * `UpdateReplacePolicy` is intentionally NOT injected — only
 * `DeletionPolicy` is required for IMPORT.
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
      r['DeletionPolicy'] = 'Delete';
      injected++;
    }
  }
  return injected;
}

export function filterTemplateForImport(
  template: Record<string, unknown>,
  plan: ImportPlanEntry[],
  // Forwarded to `overlayResourceIdentifierOnProperties`. The nested path
  // builds a phase-1 template TWICE over the same entries (1A then 1B), so the
  // second pass must stay silent or every LIST->scalar rewrite is announced
  // twice — the single-stack path has only one pass and keeps the default.
  warnOnRewrite = true
): Record<string, unknown> {
  const allow = new Map(plan.map((p) => [p.logicalId, p] as const));
  const original = template['Resources'] as Record<string, unknown>;
  const filteredResources: Record<string, unknown> = {};
  for (const [logicalId, resource] of Object.entries(original)) {
    const entry = allow.get(logicalId);
    if (!entry) continue;
    filteredResources[logicalId] = overlayResourceIdentifierOnProperties(
      resource,
      entry,
      warnOnRewrite
    );
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
 * Conditionally overlay `ResourceIdentifier` fields onto the resource's
 * `Properties` to match upstream `cdk import` behavior: pass the synth
 * template through as-is, and let CFn match resources by
 * `ResourcesToImport[].ResourceIdentifier` (the changeset API parameter)
 * regardless of whether `Properties[<IdField>]` is present.
 *
 * **Pre-v0.95 behavior**: cdkd unconditionally wrote every overlay field
 * into `Properties[<IdField>]` (even when synth produced no name property
 * at all). For auto-generated names this baked the cdkd-prefixed value
 * into the post-export CFn template (`Properties.BucketName:
 * 'cdksamplestack-...'`) while CDK synth produced `Properties: {}` (name
 * absent) — so the next `cdk diff` proposed REPLACE on every immutable
 * Name property and the very next `cdk deploy` recreated everything.
 * This defeated the "AWS resources are unchanged across the cdkd→CFn
 * migration" value proposition. Closes [#319].
 *
 * **Post-v0.95 behavior** (this function): override only when synth
 * already carries a *literal* value for the field AND it differs
 * from `ResourceIdentifier`. Four cases (the fourth added by issue #1787,
 * which also widened "literal" past `typeof === 'string'` — see
 * {@link classifyOverlayCurrentValue} for the full classification):
 *
 * - **Absent** (auto-generated names — user did NOT declare a physical
 *   name in CDK code): `Properties[field]` stays absent. Matches
 *   upstream `cdk import`, which submits the synth template untouched
 *   and CFn accepts the IMPORT changeset using `ResourceIdentifier`
 *   alone (verified empirically against AWS SQS in upstream's
 *   `import.test.ts`). Post-export `cdk diff` is clean because both
 *   CFn-managed template and CDK synth have the property absent.
 *
 * - **Intrinsic** (`{Ref: ...}` / `{Fn::GetAtt: ...}` — composite-id
 *   sub-resources whose synth template references the parent via
 *   intrinsic): the intrinsic is preserved. CFn resolves it during
 *   changeset processing — when the referenced parent is in the same
 *   IMPORT changeset, the parent's `ResourceIdentifier.<id>` value is
 *   used — so the resolved value equals the child's
 *   `ResourceIdentifier.<id>` and CFn accepts. Post-export `cdk diff`
 *   stays clean (both sides keep the intrinsic shape).
 *
 * - **Literal-mismatch** (pre-v0.94.0 prefix-on-user-declared-name
 *   legacy: user wrote `roleName: 'foo'` in CDK code; cdkd's deploy
 *   prefixed it to `'CdkSampleStack-foo'` on AWS): override
 *   `Properties.RoleName` from the unprefixed CDK value to the
 *   prefixed AWS value. CFn's identifier-match check requires this
 *   (`Properties[<IdField>]` must equal `ResourceIdentifier[<IdField>]`
 *   when both are literal strings — otherwise AWS rejects with "The
 *   Identifier [<Field>] for resource [...] does not match the
 *   identifier value for the resource in the template"). The override
 *   persists into the CFn-managed template; the next `cdk deploy`
 *   proposes REPLACE because CDK synth still emits the unprefixed
 *   name — same caveat as upstream `cdk import` with mismatched-name
 *   CDK code, and same caveat the prefix-migration pre-flight (PR
 *   #300 / `prefix-migration-check.ts`) is meant to surface before
 *   export. v0.94.0+ stacks with the default `--no-prefix-user-supplied-
 *   names` flip are no longer in this case — Properties.RoleName matches
 *   the AWS name without override.
 *
 * - **Unrepresentable** (a list carrying an intrinsic / a nested list / an
 *   empty list): REFUSED with a message naming the resource, the property and
 *   the scalar to declare instead. Preserving ANY of the three reproduces the
 *   opaque `CreateChangeSet` rejection; what makes OVERRIDING wrong differs per
 *   shape, so {@link refusalReason} says which rather than asserting one cause
 *   for all — only a list actually carrying an object element has an intrinsic
 *   to discard. Either way the command stops before submitting anything
 *   (issue #1787).
 *
 * For literal-match (Properties already has the right value), the
 * override is a no-op.
 */
function overlayResourceIdentifierOnProperties(
  resource: unknown,
  entry: ImportPlanEntry,
  // The overlay runs TWICE per export (phase-1 filter + phase-2 UPDATE
  // template) over the same entries, so an unconditional warn prints every
  // rewrite twice. Phase 1 owns the message; phase 2 stays silent.
  warnOnRewrite = true
): unknown {
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
    const current = properties[field];
    // Only override on literal mismatch. See docstring above for why absent /
    // intrinsic / matching-literal are all left alone, and
    // `classifyOverlayCurrentValue` for why a non-string LITERAL is overridden
    // rather than preserved.
    const kind = classifyOverlayCurrentValue(current);
    if (kind === 'intrinsic' || kind === 'absent') {
      continue;
    }
    if (kind === 'unrepresentable') {
      // Defense in depth. `buildImportPlan` runs the SAME classification and
      // BLOCKS the resource before any AWS write, so reaching here means the
      // pre-flight and this function disagreed — which is a cdkd bug, not a
      // user-fixable template problem. Keeping the throw means the bad value
      // still cannot reach CreateChangeSet.
      throw new Error(unrepresentableOverlayMessage(entry, field, current, value));
    }
    if (current !== value) {
      if (warnOnRewrite && typeof current !== 'string') {
        // The three cases the pre-#1787 rule handled were all string-vs-string,
        // so a rewrite was invisible by construction. Rewriting a LIST or a
        // number is a shape change the user inherits in the CFn-managed
        // template, and their next `cdk deploy` diffs against it — so say so
        // rather than truncating silently.
        getLogger().warn(
          `${entry.logicalId} (${entry.resourceType}): rewriting the identifier property ` +
            `'${field}' from ${describeOverlayValueShape(current)} to the scalar '${value}' ` +
            `recorded in cdkd state. CloudFormation types this property as a string; the ` +
            `exported template will carry the scalar.`
        );
      }
      properties[field] = value;
    }
  }
  return { ...r, Properties: properties };
}

/**
 * Why a given `unrepresentable` value is refused rather than rewritten.
 *
 * THREE shapes reach `unrepresentable`, and they are refused for two different
 * reasons — an earlier revision of this message asserted the intrinsic reason
 * for all of them, which is false for two of the three. The distinction is not
 * cosmetic: a message that names a cause the value does not have sends the user
 * looking for an intrinsic that is not there.
 */
function refusalReason(current: unknown): string {
  if (Array.isArray(current) && current.length === 0) {
    return 'cdkd will not invent a scalar where the template declared no value';
  }
  // Only a list that actually CARRIES an object element has an intrinsic to
  // protect. A nested list, or one holding `null`, has none — it is simply not
  // representable as the scalar the schema declares.
  const carriesIntrinsic =
    Array.isArray(current) &&
    current.some((e) => e !== null && typeof e === 'object' && !Array.isArray(e));
  return carriesIntrinsic
    ? 'cdkd will not rewrite it, because doing so would discard the intrinsic it carries'
    : 'cdkd will not replace a value it cannot represent as the scalar the schema declares';
}

/**
 * The shared message for a refused overlay value — used by the pre-flight in
 * {@link buildImportPlan} (which BLOCKS the resource) and by
 * {@link overlayResourceIdentifierOnProperties}'s defense-in-depth throw, so
 * the two cannot drift into describing the same defect differently.
 */
function unrepresentableOverlayMessage(
  entry: { logicalId: string; resourceType: string },
  field: string,
  current: unknown,
  value: string
): string {
  return (
    `${entry.logicalId} (${entry.resourceType}): the identifier property '${field}' is ` +
    `${describeOverlayValueShape(current)}, but CloudFormation types it as a string. ` +
    `${refusalReason(current)}. ` +
    `Declare '${field}' as the scalar '${value}' (or drop the addPropertyOverride that ` +
    `made it a list) and re-run 'cdkd export'.`
  );
}

/**
 * Every overlay field of `entry` whose value in `resource`'s `Properties` is
 * {@link classifyOverlayCurrentValue}-`unrepresentable`.
 *
 * Exists so the refusal happens during PLANNING rather than during template
 * preprocessing. `overlayResourceIdentifierOnProperties` is called from three
 * places, and two of them are past the point of no return: `--dry-run` returns
 * BEFORE any overlay call (so a dry run would report a clean plan for a
 * template the real run aborts on), and the nested-stack path calls it inside
 * the per-stack IMPORT loop — where a throw on stack N leaves stacks 1..N-1
 * already imported, outside the loop's own "stacks imported so far" recovery
 * handler. Running the same classification in `buildImportPlan` puts the
 * verdict where every other unfixable-resource verdict already lives: reported
 * for EVERY offender at once, before the lock, before dry-run's return, and
 * before any AWS write.
 */
function unrepresentableOverlayFields(
  resource: unknown,
  overlay: Record<string, string>
): { field: string; current: unknown; value: string }[] {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return [];
  const props = (resource as Record<string, unknown>)['Properties'];
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  const bag = props as Record<string, unknown>;
  const out: { field: string; current: unknown; value: string }[] = [];
  for (const [field, value] of Object.entries(overlay)) {
    if (classifyOverlayCurrentValue(bag[field]) === 'unrepresentable') {
      out.push({ field, current: bag[field], value });
    }
  }
  return out;
}

/**
 * Classify what the synth template currently carries at an identifier field,
 * for {@link overlayResourceIdentifierOnProperties} (issue #1787).
 *
 * The pre-#1787 rule was `typeof current === 'string'`, which is correct for
 * the two cases it was designed for (an absent key, and a `Ref` / `Fn::GetAtt`
 * intrinsic that must be preserved — issue #319) and WRONG for a third,
 * reachable case: a field the template carries as a non-string LITERAL. The
 * measured instance is `AWS::S3Tables::Namespace`, whose CFn registry type is
 * `{"type": "string"}` and whose CDK L1 emits a string, but
 * `addPropertyOverride('Namespace', ['analytics'])` synthesizes
 * `"Namespace": ["analytics"]` — which cdkd deploys, because
 * `s3-tables-provider.ts` accepts both wire shapes. The array is not a literal
 * string, so the overlay left it alone and it reached `CreateChangeSet`, where
 * CFn answered with an opaque rejection.
 *
 * The classification, and why each arm is what it is:
 *
 * - `absent` (`undefined` only) — unchanged. An auto-generated name the user
 *   never declared; CFn accepts the IMPORT on `ResourceIdentifier` alone. An
 *   explicit `null` is deliberately NOT here: the key IS present, the shallow
 *   Properties copy keeps it, and `"Namespace": null` then reaches
 *   `CreateChangeSet` — the same opaque-rejection class as the array, through
 *   the same `addPropertyOverride` hatch. It is a literal, and overwritten.
 * - `intrinsic` (a non-array object) — unchanged. `{Ref: Parent}` /
 *   `{Fn::GetAtt: [...]}` resolve during changeset processing to exactly this
 *   resource's `ResourceIdentifier` value, so clobbering them would only make
 *   the post-export `cdk diff` dirty (issue #319).
 * - `literal` (string / number / boolean, or an array of those) — OVERRIDDEN
 *   with the overlay value. This is not a guess: the overlay value comes from
 *   the cdkd-recorded physicalId, which is the authority on what the resource
 *   IS, while the template side is only what CDK happened to synthesize. So a
 *   single-element `['analytics']` and a bare `analytics` both become the
 *   scalar CFn's schema declares, exactly as the pre-existing prefixed-name
 *   literal-mismatch case already does.
 * - `unrepresentable` (an array containing an object / array / null, or an
 *   EMPTY array) — REFUSED. Preserving any of them ships the same opaque CFn
 *   rejection this change exists to remove; the reason OVERRIDING is wrong
 *   differs by shape, and {@link refusalReason} splits it three ways rather
 *   than asserting one cause:
 *     - a list carrying an OBJECT element — overriding discards an intrinsic
 *       the user wrote;
 *     - a NESTED list, or one holding `null` — no intrinsic to protect, it is
 *       simply not representable as the declared scalar;
 *     - an EMPTY list — nothing to reconcile against the identifier, and
 *       materializing a scalar where the template declared "no value" is the
 *       invention this classification exists to avoid.
 *   Saying "would discard an intrinsic" for all three was the defect the
 *   #1787 review round removed; do not re-collapse it.
 */
function classifyOverlayCurrentValue(
  current: unknown
): 'absent' | 'intrinsic' | 'literal' | 'unrepresentable' {
  if (current === undefined) {
    return 'absent';
  }
  if (current === null) {
    // Present-but-null. See the `absent` note above: skipping this would leave
    // the key in the emitted template.
    return 'literal';
  }
  if (Array.isArray(current)) {
    if (current.length === 0) {
      return 'unrepresentable';
    }
    return current.every(
      (e) => typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean'
    )
      ? 'literal'
      : 'unrepresentable';
  }
  if (typeof current === 'object') {
    return 'intrinsic';
  }
  return 'literal';
}

/**
 * Human-readable shape of an overlay value, for the refusal error and the
 * rewrite warning. Bounded: the value is user-supplied and lands in an error
 * message that a failed export persists, so a large list is summarized rather
 * than serialized whole.
 */
function describeOverlayValueShape(current: unknown): string {
  if (Array.isArray(current)) {
    if (current.length === 0) return 'an empty list';
    const preview = JSON.stringify(current);
    const shown = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
    return `a ${current.length}-element list (${shown})`;
  }
  if (current === null) return 'an explicit null';
  return `a ${typeof current} (${JSON.stringify(current)})`;
}

/**
 * Build the phase-2 UPDATE template: full synth template with the same
 * conditional overlay applied to every phase-1 import. Phase-1 and
 * phase-2 must stay symmetric — when `overlayResourceIdentifierOnProperties`
 * touches a field in phase 1, phase 2 must also have that touch — or
 * CFn sees a "property removed / changed" diff between the phase-1
 * IMPORT'd state and a raw phase-2 synth template, triggering silent
 * REPLACEMENT of every imported resource whose touched property is
 * immutable (see PR #316 for the silent-REPLACE bug that first
 * surfaced this asymmetry).
 *
 * Closes [#319]: as of v0.95 the overlay is **conditional** — it only
 * fires when synth has a literal-string value for the field that differs
 * from `ResourceIdentifier` (the pre-v0.94.0 prefix-on-user-declared-name
 * legacy case). For auto-generated names (Properties absent) and
 * composite-id intrinsics (`{Ref: ...}`), no overlay is applied — and
 * since both phase-1 and phase-2 walk the same `overlayResourceIdentifier
 * OnProperties` logic, the symmetry holds with no extra phase-2 handling
 * required. Post-export `cdk diff` is clean for the no-overlay cases
 * (matches upstream `cdk import` behavior).
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
      resourcesMap[entry.logicalId] = overlayResourceIdentifierOnProperties(r, entry, false);
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

export interface ChangeSetUploadOpts {
  /**
   * cdkd state bucket reused as transient template storage when the
   * serialized template exceeds the inline 51,200-byte TemplateBody
   * limit. Both phase-1 (IMPORT) and phase-2 (UPDATE) changesets share
   * this routing so the contract is symmetric — a stack that needs the
   * upload path in phase-1 will need it in phase-2 too, and the inline
   * path stays cheap (no S3 round-trip) for the common case.
   */
  stateBucket: string;
  /**
   * AWS auth context forwarded to the S3 client that performs the
   * transient upload + delete. Threaded from the export CLI's
   * `--profile` resolution so the upload uses the same identity that
   * resolved cdkd state.
   */
  s3ClientOpts?: CfnUploadS3ClientOpts;
}

/**
 * Decide whether to submit a CFn changeset's template inline via
 * `TemplateBody` or upload it to the cdkd state bucket and submit via
 * `TemplateURL`. Returns a discriminated outcome:
 *
 *   - `kind: 'inline'`  — payload <= 51,200 bytes; pass `TemplateBody`
 *     directly. No S3 round-trip; the caller's `finally` cleanup is a
 *     no-op.
 *   - `kind: 'url'`     — payload in (51,200, 1,048,576] bytes; helper
 *     uploaded to `cdkd-migrate-tmp/<stackName>/<ts>.{json,yaml}`. The
 *     caller MUST invoke the returned `cleanup` in a `finally` so the
 *     transient object is deleted regardless of CFn success / failure.
 *
 * Payloads > 1,048,576 bytes throw pre-flight (the 1 MB ceiling applies
 * to every CFn API surface; no S3 indirection helps). The error names the
 * top inline-payload contributors so the user knows what to shrink.
 *
 * `phaseLabel` is interpolated into the pre-flight error so the user
 * sees which phase tripped the ceiling ("phase-1 IMPORT" vs "phase-2
 * UPDATE").
 *
 * When `uploadOpts` is undefined (e.g. unit tests that exercise only the
 * inline path), templates over the inline limit throw with a clear
 * "no upload bucket configured" error rather than silently failing on a
 * downstream CFn rejection.
 *
 * `templateFormat` (default `'json'`) drives the transient S3 object's
 * key suffix + Content-Type so YAML-authored templates stay YAML on the
 * wire (`.yaml` / `application/x-yaml`).
 */
/* Exported for unit testing. Internal to the export flow otherwise. */
export async function selectChangeSetTemplateSource(
  template: Record<string, unknown>,
  templateBody: string,
  uploadOpts: ChangeSetUploadOpts | undefined,
  stackName: string,
  phaseLabel: string,
  templateFormat: TemplateFormat = 'json'
): Promise<
  | { kind: 'inline'; templateBody: string; cleanup: () => Promise<void> }
  | { kind: 'url'; templateUrl: string; cleanup: () => Promise<void> }
> {
  const logger = getLogger();
  if (templateBody.length <= CFN_TEMPLATE_BODY_LIMIT) {
    return { kind: 'inline', templateBody, cleanup: async () => undefined };
  }
  if (templateBody.length > CFN_TEMPLATE_URL_LIMIT) {
    // Pre-flight refusal: the 1 MB ceiling applies to every CFn API
    // surface, so no S3 indirection helps. Surface the heaviest
    // contributors (typically inline Code.ZipFile Lambdas) so the user
    // knows what to shrink — `lambda.Code.fromAsset(...)` is the
    // typical fix for the >1 MB common case; otherwise split the stack
    // via nested `AWS::CloudFormation::Stack` resources.
    const offenders = findLargeInlineResources(template);
    let detail = '';
    if (offenders.length > 0) {
      const lines = offenders
        .slice(0, 10)
        .map((o) => `  - ${o.logicalId} (${o.resourceType}): ~${o.approxBytes} bytes`);
      detail = `\nLargest inline payloads (move these to lambda.Code.fromAsset or split into nested stacks):\n${lines.join('\n')}`;
      if (offenders.length > 10) {
        detail += `\n  (and ${offenders.length - 10} more above the 4096-byte threshold)`;
      }
    }
    throw new Error(
      `${phaseLabel} template is ${templateBody.length} bytes, over the ` +
        `${CFN_TEMPLATE_URL_LIMIT}-byte CloudFormation TemplateURL limit. Templates that ` +
        `large cannot be submitted to CloudFormation — shrink inline payloads (e.g. ` +
        `inline Lambda Code.ZipFile larger than ~4 KB → switch to lambda.Code.fromAsset) ` +
        `or split the stack into nested AWS::CloudFormation::Stack resources.${detail}`
    );
  }
  if (!uploadOpts) {
    throw new Error(
      `${phaseLabel} template is ${templateBody.length} bytes, over the inline ` +
        `${CFN_TEMPLATE_BODY_LIMIT}-byte TemplateBody limit, but no upload bucket was ` +
        `provided to selectChangeSetTemplateSource — pass uploadOpts to enable the ` +
        `TemplateURL upload path.`
    );
  }
  logger.info(
    `  Template is ${templateBody.length} bytes (over ${CFN_TEMPLATE_BODY_LIMIT} inline limit) — ` +
      `uploading to state bucket '${uploadOpts.stateBucket}'.`
  );
  const uploaded = await uploadCfnTemplate({
    bucket: uploadOpts.stateBucket,
    body: templateBody,
    stackName,
    format: templateFormat,
    ...(uploadOpts.s3ClientOpts && { s3ClientOpts: uploadOpts.s3ClientOpts }),
  });
  return { kind: 'url', templateUrl: uploaded.url, cleanup: uploaded.cleanup };
}

/**
 * Best-effort wrapper around the `cleanup` callback returned by
 * {@link selectChangeSetTemplateSource}. Mirrors the warn-on-failure
 * pattern from `retireCloudFormationStack` so a stranded `cdkd-migrate-tmp/`
 * object never blocks the calling command — it lives under an obviously
 * named prefix and can be reaped manually.
 */
async function runTemplateUploadCleanup(
  cleanup: () => Promise<void>,
  bucket: string
): Promise<void> {
  const logger = getLogger();
  try {
    await cleanup();
  } catch (cleanupErr) {
    const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
    logger.warn(
      `Failed to delete temporary template upload from '${bucket}'. ` +
        `Clean up manually under prefix 'cdkd-migrate-tmp/'. Cause: ${msg}`
    );
  }
}

export async function executeImportChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  plan: ImportPlanEntry[],
  parameters: Parameter[],
  templateFormat: TemplateFormat = 'json',
  uploadOpts?: ChangeSetUploadOpts
): Promise<void> {
  const resourcesToImport: ResourceToImport[] = plan.map((entry) => ({
    ResourceType: entry.resourceType,
    LogicalResourceId: entry.logicalId,
    ResourceIdentifier: entry.resourceIdentifier,
  }));
  await submitImportChangeSet(
    cfnClient,
    stackName,
    template,
    resourcesToImport,
    parameters,
    templateFormat,
    uploadOpts
  );
}

/**
 * Submit one CloudFormation IMPORT changeset for `stackName`, awaiting
 * both `CreateChangeSet` and `ExecuteChangeSet` to completion. Accepts a
 * pre-built `resourcesToImport` array (caller-controlled) so non-leaf
 * parents in the per-stack IMPORT loop (issue #464 PR B2) can pass a
 * mixed list of leaf resources AND `AWS::CloudFormation::Stack` adoption
 * entries (with `ResourceIdentifier: { StackId: <child-CFn-arn> }`).
 *
 * Extracted from {@link executeImportChangeSet} so the leaf-only callers
 * (top-level export, single-stack flow) and the non-leaf-parent caller
 * (nested per-stack loop) share the exact same submit + wait + cleanup
 * code path — no risk of divergence on retry shape, changeset cleanup
 * on failure, or transient-upload reaping.
 *
 * Exported for unit testing.
 */
export async function submitImportChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  resourcesToImport: ResourceToImport[],
  parameters: Parameter[],
  templateFormat: TemplateFormat = 'json',
  uploadOpts?: ChangeSetUploadOpts
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-migrate-${Date.now()}`;
  const templateBody = stringifyCfnTemplate(template, templateFormat);

  logger.info(
    `Creating IMPORT changeset '${changeSetName}' for stack '${stackName}' ` +
      `(${resourcesToImport.length} resource(s), ${templateBody.length} bytes)...`
  );

  // Route by serialized size: <= 51,200 inline TemplateBody, otherwise
  // upload to the cdkd state bucket and submit via TemplateURL. Templates
  // > 1 MB pre-flight refuse with the offending-resources list.
  const source = await selectChangeSetTemplateSource(
    template,
    templateBody,
    uploadOpts,
    stackName,
    'Filtered phase-1 IMPORT',
    templateFormat
  );
  try {
    try {
      await cfnClient.send(
        new CreateChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
          ChangeSetType: 'IMPORT',
          ...(source.kind === 'inline'
            ? { TemplateBody: source.templateBody }
            : { TemplateURL: source.templateUrl }),
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
        // Changeset creation settles in seconds; the SDK default cadence (30s
        // first poll) would dominate the wait (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 600, minDelay: 2, maxDelay: 5 },
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
        // Minutes-scale CFn operation: 10s polling is dense enough and stays
        // within the repo-wide waiter cap (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 3600, minDelay: 5, maxDelay: 10 },
        { StackName: stackName }
      );
    } catch (err) {
      // On IMPORT failure, fetch the per-resource failure reasons from
      // CFn stack events so the user can see WHICH resource failed and
      // WHY. The waiter only reports the high-level rollback state.
      const failureSummary = await collectImportFailureSummary(cfnClient, stackName).catch(
        () => ''
      );
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      if (failureSummary) {
        throw new Error(`IMPORT changeset failed:\n${failureSummary}`, { cause: err });
      }
      throw err;
    }
  } finally {
    // Best-effort delete of the transient template upload, if any. CFn has
    // already copied the template into its internal storage during the
    // synchronous CreateChangeSet call, so the S3 object is no longer
    // needed regardless of whether the wait / execute steps succeeded.
    // The cleanup callback for the inline path is a no-op, so this is
    // always cheap to invoke.
    await runTemplateUploadCleanup(source.cleanup, uploadOpts?.stateBucket ?? '');
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
 * Flip a CFn stack's status from `IMPORT_COMPLETE` to `UPDATE_COMPLETE`
 * via a no-op `UpdateStack` with a stack-level tag-only change. Used
 * after each non-root stack's Phase 1A IMPORT (and after each non-leaf
 * parent's Phase 1B IMPORT) so the stack can be referenced as a nested
 * member by its own parent's later Phase 1B adoption.
 *
 * Why this is needed: AWS's "Nest an existing stack" IMPORT changeset
 * validation rejects child stacks in `IMPORT_COMPLETE` status with
 * `Stack <arn> is not in an importable status, current stack status is
 * IMPORT_COMPLETE`. The accepted statuses for nesting are
 * `CREATE_COMPLETE` and `UPDATE_COMPLETE`. A no-op tag-only `UpdateStack`
 * with `UsePreviousTemplate: true` flips the status without mutating any
 * resources: the existing template is re-applied verbatim, only the
 * stack-level Tags collection changes (the timestamp-bearing
 * `cdkd:nested-export-flip` tag is the only delta). This is the canonical
 * AWS workaround for the IMPORT_COMPLETE → UPDATE_COMPLETE transition.
 *
 * Idempotency: each invocation uses a fresh ISO 8601 timestamp PLUS an
 * 8-char random UUID slice as the tag value so AWS never returns "No
 * updates are to be performed" (which would leave the stack stuck in
 * `IMPORT_COMPLETE`). The timestamp alone is insufficient — two rapid
 * back-to-back flips on the same stack within the same millisecond (e.g.
 * a retry after a transient SDK error) would otherwise emit identical
 * values; the UUID suffix guarantees uniqueness regardless of clock
 * resolution. The tag accumulates across retries — harmless and easy to
 * reap manually under the `cdkd:` prefix.
 *
 * `parameters` must be the SAME Parameters the stack was just IMPORTed
 * with: a `UsePreviousTemplate: true` update on a stack that declares
 * Parameters (especially no-`Default` ones fed by a parent-side `Ref`)
 * is rejected by CFn with `Parameters: [X] must have values` unless every
 * Parameter is re-supplied. We re-send the resolved values verbatim (a
 * true no-op — same template, same params, only the flip Tag changes).
 * Empty array = the stack has no Parameters, so the field is omitted.
 *
 * Exported for unit testing.
 */
export async function flipStackToUpdateComplete(
  cfnClient: AwsClients['cloudFormation'],
  cfnStackName: string,
  parameters: Parameter[]
): Promise<void> {
  await cfnClient.send(
    new UpdateStackCommand({
      StackName: cfnStackName,
      UsePreviousTemplate: true,
      // Re-supply the stack's Parameters (no-op values) so the
      // UsePreviousTemplate update validates against a template that
      // declares no-`Default` Parameters. Omitted when the stack has none.
      ...(parameters.length > 0 && { Parameters: parameters }),
      Tags: [
        {
          Key: 'cdkd:nested-export-flip',
          Value: `${new Date().toISOString()}-${randomUUID().slice(0, 8)}`,
        },
      ],
      // Preserve all the standard cdkd export Capabilities (CDK templates
      // routinely declare IAM resources). The previous template's
      // capabilities are NOT auto-inherited — the SDK call needs them
      // explicitly or CFn rejects with `requires capabilities: [...]`.
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
    })
  );
  await waitUntilStackUpdateComplete(
    // Minutes-scale CFn operation: 10s polling is dense enough and stays
    // within the repo-wide waiter cap (issue #1291 item 5).
    { client: cfnClient, maxWaitTime: 1800, minDelay: 5, maxDelay: 10 },
    { StackName: cfnStackName }
  );
}

/**
 * Fetch a CFn stack's CURRENT template body via the CFn `GetTemplate`
 * `Processed` stage. Used by the non-leaf-parent branch of
 * {@link runPerStackImportLoop} to satisfy the AWS-docs "Nest an existing
 * stack" template-match requirement: the parent's
 * `AWS::CloudFormation::Stack.Properties.TemplateURL` must point at the
 * child stack's actual current template for the IMPORT changeset to
 * validate. Reading via `GetTemplate` (vs. the local cdk.out file) is
 * the only way to guarantee the AWS-side stored template byte-shape —
 * AWS may have normalized whitespace, parameter defaults, or intrinsic
 * shapes during the just-completed leaf IMPORT.
 *
 * `Processed` stage returns the template AWS has on file post-IMPORT
 * (with any macro / serverless-transform expansion already applied),
 * which is exactly what the parent's nested-stack row must reference.
 *
 * Exported for unit testing.
 */
export async function fetchCfnStackTemplate(
  cfnClient: AwsClients['cloudFormation'],
  cfnStackName: string
): Promise<string> {
  const resp = await cfnClient.send(
    new GetTemplateCommand({ StackName: cfnStackName, TemplateStage: 'Processed' })
  );
  if (!resp.TemplateBody) {
    throw new Error(
      `CFn GetTemplate returned no body for stack '${cfnStackName}'. ` +
        `The just-IMPORTed child stack may be in an unexpected state; ` +
        `check the CloudFormation console.`
    );
  }
  return resp.TemplateBody;
}

/**
 * Extract a child-IMPORT Parameter map from the parent template's
 * `Resources[<childLogicalId>].Properties.Parameters` block.
 *
 * CDK nested stacks pass parent → child Parameter values via the parent's
 * `AWS::CloudFormation::Stack.Properties.Parameters` map. For the LEAF
 * child IMPORT (which submits the child as a fresh standalone CFn stack),
 * cdkd must forward those values — otherwise the child template's
 * `Parameters` block goes unresolved and CFn rejects the changeset.
 *
 * This helper only classifies literal-string / number / boolean values
 * (forwarded directly) vs. intrinsic values (`{Ref: ...}` /
 * `{Fn::GetAtt: ...}` referencing the parent's own resources), which it
 * reports in `intrinsicSkipped`. Intrinsic resolution itself is layered on
 * top by {@link resolveChildImportParameters}, which runs the deploy
 * engine's `IntrinsicFunctionResolver` against the parent's state and only
 * falls back to "skip" (the original behavior) when the resolver cannot
 * handle a value. Callers that want resolved Parameters should use
 * {@link resolveChildImportParameters}; this sync helper stays for the
 * literal-classification step and its existing unit tests.
 *
 * Exported for unit testing.
 */
export function extractChildImportParameters(
  parentTemplate: Record<string, unknown>,
  childLogicalId: string
): { params: Parameter[]; intrinsicSkipped: string[] } {
  const resources = parentTemplate['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const row = (resources as Record<string, unknown>)[childLogicalId];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const props = (row as { Properties?: unknown }).Properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const rawParams = (props as { Parameters?: unknown }).Parameters;
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return { params: [], intrinsicSkipped: [] };
  }
  const out: Parameter[] = [];
  const intrinsicSkipped: string[] = [];
  for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out.push({ ParameterKey: k, ParameterValue: v });
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out.push({ ParameterKey: k, ParameterValue: String(v) });
    } else {
      intrinsicSkipped.push(k);
    }
  }
  return { params: out, intrinsicSkipped };
}

/**
 * Async wrapper around {@link extractChildImportParameters} that resolves
 * intrinsic-valued (`{Ref: ...}` / `{Fn::GetAtt: ...}` / `Fn::Sub` etc.)
 * Parameters via the deploy engine's {@link IntrinsicFunctionResolver}
 * before falling back to the warn+skip path. This is the closing-loop
 * for the per-stack IMPORT design: CFn's atomic nested-stack create
 * implicitly resolved these against the parent's own scope, but cdkd's
 * leaf-first per-stack IMPORT loop submits each child as a standalone
 * stack — so AWS has no parent context to resolve against, and cdkd must
 * do the resolution itself.
 *
 * Behavior (Option 1 — CDK-compatible graceful degradation):
 *   - For each entry that {@link extractChildImportParameters} reported as
 *     `intrinsicSkipped`, look up the original intrinsic value in the
 *     parent template and call `resolver.resolve(value, parentContext)`.
 *   - On success: coerce the resolved scalar (string / number / boolean /
 *     array-of-strings) to a CFn Parameter string and append to `params`.
 *   - On throw OR on unsupported result shape (object / null / undefined):
 *     keep the key in `intrinsicSkipped` — the orchestrator's existing
 *     warn-then-fall-back-to-child-Default path takes over (matches the
 *     pre-resolver behavior for unresolvable cases, so adding the resolver
 *     never makes a working scenario regress).
 *
 * The `parentContext` must be built from the PARENT's data — its template,
 * its cdkd state's `resources` (for `Ref` to parent resources and
 * `Fn::GetAtt` to parent resource attributes), and its already-resolved
 * Parameter values (for `Ref` to parent Parameters). For nested grandparent
 * chains, the parent's resolved Parameters themselves come from the
 * top-down pre-pass in {@link buildResolvedParametersPerStack} — that's
 * why parameter resolution must happen ROOT-FIRST (parent before child),
 * even though the IMPORT loop itself is leaf-first.
 *
 * Exported for unit testing.
 */
export async function resolveChildImportParameters(
  parentTemplate: Record<string, unknown>,
  parentResolverContext: ResolverContext,
  childLogicalId: string,
  resolver: IntrinsicFunctionResolver
): Promise<{ params: Parameter[]; intrinsicSkipped: string[] }> {
  const base = extractChildImportParameters(parentTemplate, childLogicalId);
  if (base.intrinsicSkipped.length === 0) {
    return base;
  }
  // Re-walk the parent template to recover the original intrinsic values
  // for each `intrinsicSkipped` key (the base helper threw away the values
  // when classifying as non-literal — that helper stays unchanged for
  // back-compat with its existing sync unit tests).
  const resources = parentTemplate['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return base;
  }
  const row = (resources as Record<string, unknown>)[childLogicalId];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return base;
  }
  const props = (row as { Properties?: unknown }).Properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return base;
  }
  const rawParams = (props as { Parameters?: unknown }).Parameters;
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return base;
  }

  const resolvedParams: Parameter[] = [...base.params];
  const stillSkipped: string[] = [];
  for (const key of base.intrinsicSkipped) {
    const intrinsicValue = (rawParams as Record<string, unknown>)[key];
    try {
      const result = await resolver.resolve(intrinsicValue, parentResolverContext);
      if (result === undefined || result === null) {
        stillSkipped.push(key);
        continue;
      }
      if (typeof result === 'string') {
        resolvedParams.push({ ParameterKey: key, ParameterValue: result });
      } else if (typeof result === 'number' || typeof result === 'boolean') {
        resolvedParams.push({ ParameterKey: key, ParameterValue: String(result) });
      } else if (Array.isArray(result)) {
        // CFn Parameter `Type: CommaDelimitedList` accepts comma-joined
        // strings — match CFn's wire shape for an array-typed Parameter.
        // Each element is coerced to string first to tolerate mixed shapes.
        resolvedParams.push({
          ParameterKey: key,
          ParameterValue: (result as unknown[]).map((e) => String(e)).join(','),
        });
      } else {
        // Resolved to an object (e.g. a nested intrinsic that didn't fully
        // collapse, or a structured shape CFn Parameters cannot carry).
        // Treat as unresolvable — keep in skipped so the warn+fallback path
        // surfaces it.
        stillSkipped.push(key);
      }
    } catch {
      // Resolver threw (most commonly: `Ref` to a Parameter not present in
      // context, `Fn::GetAtt` to a resource attr cdkd state didn't capture,
      // or an unsupported intrinsic shape). Fall back to the pre-resolver
      // behavior — keep in skipped, the orchestrator's existing warn path
      // tells the user to verify the child template's Defaults cover it.
      stillSkipped.push(key);
    }
  }
  return { params: resolvedParams, intrinsicSkipped: stillSkipped };
}

/** Minimal per-stack shape {@link buildResolvedParametersPerStack} reads. */
export interface ResolvedParamsStackNode {
  cdkdName: string;
  template: Record<string, unknown>;
  state: StackState;
}

/**
 * Top-down (root-first) pre-pass that resolves each cdkd stack's
 * child-IMPORT Parameters BEFORE the leaf-first IMPORT loop runs (issue
 * #464 follow-up — intrinsic Parameter resolution at leaf-IMPORT time).
 *
 * Why a separate pre-pass instead of resolving inline in the leaf-first
 * loop: a child's intrinsic-valued Parameter (`{Ref: ParentParam}`) resolves
 * against its PARENT's resolved Parameter values, and for a 3-level tree the
 * middle stack's Parameters are themselves resolved from the root's. So the
 * resolution dependency runs root → leaf, the opposite direction from the
 * IMPORT submission order (leaf → root). Resolving everything up front in
 * root-first order means each child always sees its parent's
 * already-resolved Parameters in `paramsByCdkdName`.
 *
 * Returns:
 *   - `paramsByCdkdName`: cdkdName → the CFn Parameters to submit for that
 *     stack's IMPORT. The root maps to `rootParameters` verbatim (CLI
 *     overrides + template defaults, resolved by the caller already); each
 *     non-root maps to its parent-extracted + intrinsic-resolved values.
 *   - `intrinsicSkippedByCdkdName`: cdkdName → the Parameter names that
 *     STILL could not be resolved (resolver threw / unsupported shape), for
 *     the orchestrator's per-stack warn + aggregate summary.
 *
 * Exported for unit testing.
 */
export async function buildResolvedParametersPerStack(args: {
  rootStackName: string;
  rootParameters: Parameter[];
  perStackNodes: ResolvedParamsStackNode[];
  tree: CdkdStateStackTree;
  resolver: IntrinsicFunctionResolver;
  stateBackend?: S3StateBackend;
}): Promise<{
  paramsByCdkdName: Map<string, Parameter[]>;
  intrinsicSkippedByCdkdName: Map<string, string[]>;
}> {
  const paramsByCdkdName = new Map<string, Parameter[]>();
  const intrinsicSkippedByCdkdName = new Map<string, string[]>();
  // Root submits the caller-resolved Parameters (CLI overrides / defaults).
  paramsByCdkdName.set(args.rootStackName, args.rootParameters);

  const nodeByName = new Map(args.perStackNodes.map((n) => [n.cdkdName, n]));
  for (const ref of flattenCdkdStateTreeRootFirst(args.tree)) {
    if (ref.stackName === args.rootStackName) continue;
    const node = nodeByName.get(ref.stackName);
    if (!node) {
      throw new Error(
        `buildResolvedParametersPerStack: tree node '${ref.stackName}' has no per-stack ` +
          `template/state entry. This is a cdkd bug.`
      );
    }
    const parentLogicalId = node.state.parentLogicalId;
    const parentStackName = node.state.parentStack;
    if (!parentLogicalId || !parentStackName) {
      throw new Error(
        `buildResolvedParametersPerStack: child '${node.cdkdName}' state is missing ` +
          `parentLogicalId / parentStack (v6 fields). Re-deploy or re-import the parent stack.`
      );
    }
    const parentNode = nodeByName.get(parentStackName);
    if (!parentNode) {
      throw new Error(
        `buildResolvedParametersPerStack: child '${node.cdkdName}' references parent ` +
          `'${parentStackName}' which is not in the per-stack node list — tree shape is inconsistent.`
      );
    }
    // The parent's resolved Parameter VALUES are the lookup table for any
    // `Ref: <ParentParam>` in the child's Parameters block. Root-first order
    // guarantees the parent was already processed.
    const parentParamValues: Record<string, unknown> = {};
    for (const p of paramsByCdkdName.get(parentStackName) ?? []) {
      if (p.ParameterKey !== undefined) parentParamValues[p.ParameterKey] = p.ParameterValue;
    }
    const parentResolverContext: ResolverContext = {
      // The runtime value is always a real CFn template (it has Resources);
      // TS can't narrow `Record<string, unknown>` to CloudFormationTemplate.
      template: parentNode.template as unknown as ResolverContext['template'],
      resources: parentNode.state.resources,
      parameters: parentParamValues,
      stackName: parentNode.cdkdName,
      ...(args.stateBackend && { stateBackend: args.stateBackend }),
    };
    const { params, intrinsicSkipped } = await resolveChildImportParameters(
      parentNode.template,
      parentResolverContext,
      parentLogicalId,
      args.resolver
    );
    paramsByCdkdName.set(node.cdkdName, params);
    if (intrinsicSkipped.length > 0) {
      intrinsicSkippedByCdkdName.set(node.cdkdName, intrinsicSkipped);
    }
  }
  return { paramsByCdkdName, intrinsicSkippedByCdkdName };
}

/**
 * Per-stack record of a successfully-IMPORTed stack within a
 * {@link runPerStackImportLoop} run. The orchestrator collects these as
 * each stack's phase-1 IMPORT completes so:
 *   - The next stack's iteration can adopt this stack as a nested
 *     reference via the recorded `cfnStackArn`.
 *   - On a mid-loop failure, the error message can name which stacks
 *     successfully moved to CFn (and whose cdkd state is therefore
 *     stale and should be cleared after the user resolves the failure
 *     cause).
 */
export interface ImportedStackRecord {
  /** cdkd state-key form (e.g. `MyApp~Database`). */
  cdkdStackName: string;
  /** CFn stack name actually submitted (post-`cdkd2cfnStackName` mapping or override). */
  cfnStackName: string;
  /** Full CFn stack ARN captured from `DescribeStacks` post-IMPORT. */
  cfnStackArn: string;
}

/**
 * Outcome of a {@link runPerStackImportLoop} invocation. Reflects whether
 * the run actually mutated AWS state, surfaced for the caller's logging.
 */
export interface PerStackImportLoopResult {
  outcome: 'success' | 'dry-run' | 'cancelled';
  importedStacks: ImportedStackRecord[];
}

/**
 * Caller-supplied dependencies for {@link runPerStackImportLoop}. Grouped
 * into one object so the orchestrator's signature stays readable even as
 * the dependency surface grows. Mirrors the
 * `retireCloudFormationStack`-style dependency-injection shape.
 */
export interface RunPerStackImportLoopDeps {
  cfnClient: AwsClients['cloudFormation'];
  /**
   * Live-read seam for the identifier BACKFILL (issue #1791). Optional for the
   * same reason `buildImportPlan`'s is: a caller without one keeps the
   * state-only refusal.
   */
  ec2Client?: AwsClients['ec2'];
  stateBackend: S3StateBackend;
  lockManager: LockManager;
  uploadOpts: ChangeSetUploadOpts;
  /** `process.env.USER@HOST:PID`-style lock-ownership tag for nested-child lock acquisition. */
  lockOwner: string;
}

/**
 * Caller-supplied option flags for {@link runPerStackImportLoop}. Mirrors
 * the `--dry-run` / `--yes` / `--include-non-importable` /
 * `--recreate-import-unsupported` shape of {@link exportCommand}'s own
 * CLI options, so the orchestrator can be invoked from a single call
 * site without duplicating option parsing.
 */
export interface RunPerStackImportLoopOptions {
  dryRun: boolean;
  yes: boolean;
  includeNonImportable: boolean;
  recreateImportUnsupported: boolean;
  /** See {@link ExportOptions.skipImportSupportPreflight}. Applies to every stack in the tree. */
  skipImportSupportPreflight?: boolean;
}

/**
 * Per-stack IMPORT loop driving `cdkd export` for nested-stack trees
 * (issue #464 PR B2). Submits one IMPORT changeset per cdkd-managed stack
 * in leaf-first order. For non-leaf parents, each `AWS::CloudFormation::Stack`
 * row in the parent's template is adopted as a nested reference via the
 * AWS-docs "Nest an existing stack" pattern: `DeletionPolicy: Retain` is
 * injected, the row's `TemplateURL` is rewritten to point at the just-IMPORTed
 * child stack's current template (fetched via `GetTemplate`), and the
 * row is added to `ResourcesToImport[]` with
 * `{ ResourceIdentifier: { StackId: <child-CFn-arn> } }`.
 *
 * The original "one atomic `--include-nested-stacks` IMPORT changeset"
 * design (#464 design doc §4.3 original) was empirically rejected by AWS:
 * `IncludeNestedStacks is not supported for changeSet type: IMPORT`. See
 * §4.0 of the design doc for the spike findings + per-stack loop rationale.
 *
 * Algorithm:
 *   1. Pre-flight (before any AWS mutation):
 *      - Build per-stack import plans from the tree.
 *      - Reject if any stack has blocked resources OR phase-2 non-importable
 *        resources without `--include-non-importable`.
 *      - Verify no CFn stack already exists under the resolved CFn name
 *        for any tree node.
 *      - Print the per-stack plan summary.
 *      - In `--dry-run`: return without acquiring locks or submitting
 *        changesets.
 *      - Prompt the user once for the whole tree migration (unless `--yes`).
 *      - Acquire per-non-root-child locks (root's lock is already held by
 *        `exportCommand`'s outer scope).
 *   2. Main loop, leaf-first across the tree. Per stack:
 *      - Build the filtered phase-1 template + `ResourcesToImport[]` array.
 *      - For non-leaf parents: per nested-stack row, fetch the child's
 *        current template via `GetTemplate`, upload to S3 (cleanup
 *        accumulated for the outer `finally`), inject Retain + rewrite
 *        TemplateURL, append to `ResourcesToImport[]` with
 *        `{ StackId: <child-arn> }`.
 *      - Submit IMPORT changeset via {@link submitImportChangeSet}.
 *      - Capture the resulting CFn stack ARN via `DescribeStacks` for
 *        the next parent iteration's reference.
 *      - Per-stack phase-2: pre-delete IMPORT-unsupported resources, then
 *        UPDATE changeset for Custom Resources (same shape as the
 *        flat-stack code path, just scoped to this stack).
 *   3. After all stacks IMPORTed: delete cdkd state leaf-first.
 *   4. Always (success AND failure paths):
 *      - Release per-non-root-child locks in reverse order.
 *      - Drain transient template uploads.
 *
 * Failure semantics: each per-stack IMPORT is independent. If leaf A
 * succeeds but parent B fails, A is a standalone CFn stack with A's cdkd
 * state DELETED, while B's cdkd state is PRESERVED. The error message
 * names which stacks moved + which remain. Re-running `cdkd export
 * <parent>` after the failure cause is fixed adopts A as a nested
 * reference (since A is now an existing CFn stack) — the per-stack loop
 * is idempotent in that direction.
 *
 * Exported for unit testing.
 */
export async function runPerStackImportLoop(args: {
  rootStackName: string;
  rootRegion: string;
  rootStackInfoNestedTemplates: Record<string, string>;
  rootTemplateFormat: TemplateFormat;
  tree: CdkdStateStackTree;
  rootTemplate: Record<string, unknown>;
  cfnStackNameOverrides: {
    /** Root cdkd stack name → CFn stack name (single, from `--cfn-stack-name`). */
    root?: string | undefined;
    /** Per-child cdkd stack name → CFn stack name (from `--cfn-child-stack-name`). */
    childMap: Map<string, string>;
  };
  rootParameters: Parameter[];
  deps: RunPerStackImportLoopDeps;
  options: RunPerStackImportLoopOptions;
}): Promise<PerStackImportLoopResult> {
  const logger = getLogger();
  const {
    rootStackName,
    rootRegion,
    rootStackInfoNestedTemplates,
    rootTemplateFormat,
    tree,
    rootTemplate,
    cfnStackNameOverrides,
    rootParameters,
    deps,
    options,
  } = args;

  // Resolve cdkdName → CFn stack name. Root has its own override flag;
  // children fall back to cdkd2cfnStackName (replace `~` with `-`) unless
  // the user supplied `--cfn-child-stack-name`.
  const cfnStackNameOf = (cdkdName: string): string => {
    if (cdkdName === rootStackName) {
      return cfnStackNameOverrides.root ?? cdkd2cfnStackName(cdkdName);
    }
    return cfnStackNameOverrides.childMap.get(cdkdName) ?? cdkd2cfnStackName(cdkdName);
  };

  // Build per-stack template / state metadata for every tree node.
  const nodesByCdkdName = buildPerStackImportNodes(
    rootStackName,
    rootTemplate,
    rootStackInfoNestedTemplates,
    rootTemplateFormat,
    tree
  );
  const leafFirst = flattenCdkdStateTreeLeafFirst(tree);

  // Sanity: every tree node must have a per-stack node entry.
  for (const n of leafFirst) {
    if (!nodesByCdkdName.has(n.stackName)) {
      throw new Error(
        `runPerStackImportLoop: missing per-stack template for '${n.stackName}' — ` +
          `tree node has cdkd state but no synth template was loaded. This is a cdkd bug.`
      );
    }
  }

  // ---- Pre-flight: build per-stack plans + classify ----
  interface PerStackPlan {
    cdkdName: string;
    cfnName: string;
    region: string;
    template: Record<string, unknown>;
    templateFormat: TemplateFormat;
    state: StackState;
    phase1Imports: ImportPlanEntry[];
    phase2Creates: Phase2CreateEntry[];
    recreateBeforePhase2: RecreateBeforePhase2Entry[];
    nestedStackRows: NestedStackRow[];
  }
  const perStackPlans: PerStackPlan[] = [];
  for (const node of leafFirst) {
    const meta = nodesByCdkdName.get(node.stackName)!;
    const plan = await buildImportPlan(
      meta.state,
      meta.template,
      deps.cfnClient,
      meta.cdkdStackName,
      {
        recreateImportUnsupported: options.recreateImportUnsupported,
        // `=== true` not a spread: `RunPerStackImportLoopOptions` declares the
        // field optional, and `exactOptionalPropertyTypes` rejects an explicit
        // `undefined` for an optional target property.
        skipImportSupportPreflight: options.skipImportSupportPreflight === true,
        // Same reason for the conditional spread (issue #1791).
        ...(deps.ec2Client && { ec2Client: deps.ec2Client }),
      }
    );
    if (plan.blocked.length > 0) {
      const lines = groupBlockedReasons(plan.blocked);
      throw new Error(
        `Stack '${meta.cdkdStackName}' has ` +
          `${new Set(plan.blocked.map((b) => b.logicalId)).size} resource(s) that block ` +
          `migration:\n${lines.join('\n')}`
      );
    }
    perStackPlans.push({
      cdkdName: meta.cdkdStackName,
      cfnName: cfnStackNameOf(meta.cdkdStackName),
      region: meta.region,
      template: meta.template,
      templateFormat: meta.templateFormat,
      state: meta.state,
      phase1Imports: plan.phase1Imports,
      phase2Creates: plan.phase2Creates,
      recreateBeforePhase2: plan.recreateBeforePhase2,
      nestedStackRows: plan.nestedStackRows,
    });
  }

  // Aggregate phase-2 totals for the include-non-importable gate.
  const totalPhase2Creates = perStackPlans.reduce((acc, p) => acc + p.phase2Creates.length, 0);
  const totalRecreate = perStackPlans.reduce((acc, p) => acc + p.recreateBeforePhase2.length, 0);

  // ---- Print the per-stack plan summary ----
  logger.info('');
  logger.info(
    `Migrating cdkd nested-stack tree rooted at '${rootStackName}' → CloudFormation ` +
      `(${perStackPlans.length} stack(s), leaf-first):`
  );
  for (const plan of perStackPlans) {
    logger.info(
      `  [${plan.cdkdName}] → CFn stack '${plan.cfnName}': ` +
        `${plan.phase1Imports.length} leaf import(s)` +
        (plan.nestedStackRows.length > 0
          ? `, ${plan.nestedStackRows.length} nested-child adoption(s)`
          : '') +
        (plan.phase2Creates.length > 0 ? `, ${plan.phase2Creates.length} phase-2 CREATE(s)` : '') +
        (plan.recreateBeforePhase2.length > 0
          ? `, ${plan.recreateBeforePhase2.length} pre-delete + re-CREATE`
          : '')
    );
  }
  logger.info('');

  // ---- Include-non-importable gate (whole-tree) ----
  if (totalPhase2Creates > 0 && !options.includeNonImportable) {
    if (options.dryRun) {
      logger.warn(
        `${totalPhase2Creates} non-importable resource(s) (Custom::*) across the tree. ` +
          `A real run would require --include-non-importable for phase-2 CFn CREATE (re-invokes ` +
          `each Custom Resource's backing Lambda onCreate handler — ensure idempotent).`
      );
      logger.info('--dry-run: no CloudFormation changesets will be created.');
      return { outcome: 'dry-run', importedStacks: [] };
    }
    throw new Error(
      `${totalPhase2Creates} non-importable resource(s) (Custom::*) across the cdkd ` +
        `nested-stack tree. Pass --include-non-importable to run a per-stack 2-phase migration ` +
        `(phase 1 imports the importable resources for each stack; phase 2 CFn-CREATEs the ` +
        `non-importable ones per stack, which re-invokes each Custom Resource's onCreate ` +
        `handler — make sure those are idempotent). Or destroy the Custom Resources first.`
    );
  }

  // ---- Pre-flight: every CFn name in the tree must be free ----
  for (const plan of perStackPlans) {
    await assertCfnStackAbsent(deps.cfnClient, plan.cfnName);
  }

  // ---- Dry-run: return now (before any lock / AWS mutation) ----
  if (options.dryRun) {
    logger.info('--dry-run: no CloudFormation changesets will be created.');
    return { outcome: 'dry-run', importedStacks: [] };
  }

  // ---- Single tree-wide confirmation prompt ----
  if (!options.yes) {
    const phase2Note =
      totalPhase2Creates > 0
        ? ` Phase 2 will CREATE ${totalPhase2Creates} non-importable resource(s) across the tree.`
        : '';
    const recreateNote =
      totalRecreate > 0
        ? ` cdkd will also pre-DELETE + re-CREATE ${totalRecreate} IMPORT-unsupported resource(s) ` +
          `(brief unavailability window per resource).`
        : '';
    const ok = await confirmPrompt(
      `Create ${perStackPlans.length} CloudFormation stack(s) by importing the cdkd ` +
        `nested-stack tree rooted at '${rootStackName}' (${rootRegion}) — ` +
        `leaf-first, per-stack IMPORT loop (#464 design §4.3).` +
        phase2Note +
        recreateNote +
        ` AWS resources are unchanged. cdkd state for every adopted stack will be ` +
        `deleted on success.`
    );
    if (!ok) {
      logger.info('Migration cancelled. cdkd state and CloudFormation are unchanged.');
      return { outcome: 'cancelled', importedStacks: [] };
    }
  }

  // ---- Pre-acquire per-non-root-child locks (root's lock is already held) ----
  const acquiredChildLocks: Array<{ stackName: string; region: string }> = [];
  try {
    for (const node of leafFirst) {
      if (node.stackName === rootStackName) continue;
      // Retry briefly (≈30s ceiling) so a genuinely-active concurrent run is
      // awaited rather than failing the whole tree migration instantly; an
      // expired lock from a crashed previous run is auto-cleaned by
      // `acquireLock` (30-min TTL) on the first attempt. `acquireLockWithRetry`
      // throws (it does NOT return false) on terminal failure — wrap it to
      // preserve the actionable "no changeset submitted; state unchanged"
      // message + the force-unlock pointer.
      try {
        await deps.lockManager.acquireLockWithRetry(
          node.stackName,
          node.region,
          deps.lockOwner,
          'export',
          CHILD_LOCK_RETRY_MAX_ATTEMPTS,
          CHILD_LOCK_RETRY_DELAY_MS
        );
      } catch (err) {
        throw new Error(
          `Could not acquire lock for nested-stack child '${node.stackName}' (${node.region}) — ` +
            `another cdkd process held it through the retry window. Wait for it to finish, or run ` +
            `'cdkd force-unlock ${node.stackName} --stack-region ${node.region}' if you are ` +
            `certain no other process is active. ` +
            `No CloudFormation changeset has been submitted; cdkd state is unchanged.`,
          { cause: err instanceof Error ? err : undefined }
        );
      }
      acquiredChildLocks.push({ stackName: node.stackName, region: node.region });
    }

    // ---- Main per-stack IMPORT loop ----
    const cfnArnByCdkdName = new Map<string, string>();
    const uploadCleanups: Array<() => Promise<void>> = [];
    const importedStacks: ImportedStackRecord[] = [];

    // Resolve every stack's child-IMPORT Parameters up front, ROOT-FIRST: a
    // child's intrinsic-valued Parameters (`{Ref: ParentParam}` /
    // `{Fn::GetAtt: [ParentResource, Attr]}`) resolve against its PARENT's
    // already-resolved Parameters + cdkd state — the opposite direction from
    // the leaf-first IMPORT order below, so a separate top-down pre-pass is
    // required (see `buildResolvedParametersPerStack`). `sessionIntrinsicSkipped`
    // collects the Parameters that STILL could not be resolved after the
    // resolver pass (resolver threw / unsupported shape), for the per-stack
    // warn + the aggregate summary at the end of the success path. The root
    // submits `rootParameters` verbatim.
    const paramResolver = new IntrinsicFunctionResolver(rootRegion);
    const { paramsByCdkdName, intrinsicSkippedByCdkdName: sessionIntrinsicSkipped } =
      await buildResolvedParametersPerStack({
        rootStackName,
        rootParameters,
        perStackNodes: perStackPlans.map((p) => ({
          cdkdName: p.cdkdName,
          template: p.template,
          state: p.state,
        })),
        tree,
        resolver: paramResolver,
        stateBackend: deps.stateBackend,
      });
    for (const [cdkdName, skipped] of sessionIntrinsicSkipped) {
      logger.warn(
        `  Child '${cdkdName}': could not resolve intrinsic-valued Parameter(s) ` +
          `${skipped.join(', ')} at IMPORT time. The child template's Parameter Default ` +
          `values must cover these — otherwise CFn will reject the IMPORT.`
      );
    }

    try {
      for (let i = 0; i < perStackPlans.length; i++) {
        const plan = perStackPlans[i]!;
        logger.info(
          `[${i + 1}/${perStackPlans.length}] Importing cdkd stack '${plan.cdkdName}' → ` +
            `CFn stack '${plan.cfnName}' (${plan.phase1Imports.length} leaf, ` +
            `${plan.nestedStackRows.length} nested-child adoption)`
        );

        // Per-stack Parameters were resolved up front by the root-first
        // pre-pass above (the root maps to the user-supplied values; each
        // child's intrinsic-valued Parameters were resolved against its
        // parent's state, with any unresolvable ones already warned about).
        const stackParameters = paramsByCdkdName.get(plan.cdkdName) ?? [];

        // ---- Phase 1A: leaves-only CREATE-via-IMPORT ----
        // Why 2 phases for non-leaf parents (vs. one combined CREATE-via-IMPORT
        // that includes the nested-stack adoption): AWS's "Nest an existing
        // stack" pattern (the only AWS-supported way to adopt an existing
        // standalone child CFn stack as a nested member of a parent) requires
        // both the parent AND the child to ALREADY EXIST as standalone CFn
        // stacks before the adoption changeset runs. A CREATE-via-IMPORT that
        // both creates the parent AND adopts a child fails at changeset-create
        // time with "Stack <child-arn> is not in an importable status, current
        // stack status is IMPORT_COMPLETE" — the AWS-side validator rejects
        // adopting a fresh-IMPORTed child during parent creation. See
        // [AWS docs: Nesting an existing stack](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-nested-stacks.html)
        // — the procedure explicitly assumes "existing standalone stack" for
        // both. So we always submit the parent in 2 phases: Phase 1A creates
        // the parent as a standalone stack containing its leaf resources
        // only; Phase 1B then UPDATE-IMPORTs the now-existing parent to
        // adopt the nested children.
        const phase1ATemplate = filterTemplateForImport(plan.template, plan.phase1Imports);
        const phase1AResources: ResourceToImport[] = plan.phase1Imports.map((entry) => ({
          ResourceType: entry.resourceType,
          LogicalResourceId: entry.logicalId,
          ResourceIdentifier: entry.resourceIdentifier,
        }));
        const injectedDeletion = injectDeletionPolicyForImport(phase1ATemplate);
        if (injectedDeletion > 0) {
          logger.info(
            `  Injected DeletionPolicy: Delete on ${injectedDeletion} resource(s) in ` +
              `'${plan.cdkdName}' (required by CFn IMPORT; matches CDK/CFn default).`
          );
        }

        try {
          await submitImportChangeSet(
            deps.cfnClient,
            plan.cfnName,
            phase1ATemplate,
            phase1AResources,
            stackParameters,
            plan.templateFormat,
            deps.uploadOpts
          );
        } catch (err) {
          const importedSummary =
            importedStacks.length > 0
              ? importedStacks.map((s) => `${s.cdkdStackName} → ${s.cfnStackName}`).join(', ')
              : '(none)';
          const remainingSummary = perStackPlans
            .slice(i)
            .map((p) => p.cdkdName)
            .join(', ');
          throw new Error(
            `Phase 1A IMPORT changeset failed for cdkd stack '${plan.cdkdName}' (CFn name ` +
              `'${plan.cfnName}'). Stacks imported successfully so far: ${importedSummary}. ` +
              `Stacks not yet imported (cdkd state preserved): ${remainingSummary}. ` +
              `After resolving the underlying cause, re-run 'cdkd export ${rootStackName}' — ` +
              `already-imported children will be adopted as nested references on retry. ` +
              `Cause: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err instanceof Error ? err : undefined }
          );
        }

        // Capture the just-created CFn stack's ARN for the next parent
        // iteration's `ResourceIdentifier.StackId` reference AND for
        // Phase 1B below (UPDATE-IMPORT against this same stack).
        const desc = await deps.cfnClient.send(
          new DescribeStacksCommand({ StackName: plan.cfnName })
        );
        const cfnArn = desc.Stacks?.[0]?.StackId;
        if (!cfnArn) {
          throw new Error(
            `runPerStackImportLoop: DescribeStacks returned no StackId for '${plan.cfnName}' ` +
              `immediately after Phase 1A IMPORT — AWS may be in an unexpected state.`
          );
        }
        cfnArnByCdkdName.set(plan.cdkdName, cfnArn);
        importedStacks.push({
          cdkdStackName: plan.cdkdName,
          cfnStackName: plan.cfnName,
          cfnStackArn: cfnArn,
        });
        logger.info(
          `  ✓ Phase 1A: CFn stack '${plan.cfnName}' created via IMPORT ` +
            `(${plan.phase1Imports.length} leaf resource(s)).`
        );

        // Flip the stack's status from IMPORT_COMPLETE to UPDATE_COMPLETE
        // via a no-op tag-only UpdateStack — unless this stack is the
        // root (which is never adopted as a nested member by any other
        // stack). See `flipStackToUpdateComplete` for the rationale (AWS
        // rejects IMPORT_COMPLETE as a non-importable status when
        // adopting a stack as a nested member of a parent).
        if (plan.cdkdName !== rootStackName) {
          logger.info(
            `  Flipping '${plan.cfnName}' to UPDATE_COMPLETE so it can be adopted as a ` +
              `nested member by its parent's Phase 1B...`
          );
          await flipStackToUpdateComplete(deps.cfnClient, plan.cfnName, stackParameters);
        }

        // ---- Phase 1B: UPDATE-via-IMPORT to adopt nested children ----
        // Skipped for leaf stacks (no nested-stack rows). For non-leaf
        // parents, submit a second IMPORT changeset against the now-existing
        // parent that adds the AWS::CloudFormation::Stack rows to the
        // template AND lists them in ResourcesToImport[] with
        // ResourceIdentifier: { StackId: <child-arn> } — the AWS-docs
        // "Nest an existing stack" pattern. Same changeset type as Phase
        // 1A (IMPORT); AWS infers UPDATE-IMPORT from the existing stack.
        //
        // `rewrittenNestedRows` is captured here (vs. inside the
        // `if`-block) so phase 2's UPDATE template can splice the
        // Retain-bearing nested-stack rows back in without re-fetching
        // each child's template via GetTemplate a second time. Empty
        // for leaf stacks.
        const rewrittenNestedRows = new Map<string, Record<string, unknown>>();
        if (plan.nestedStackRows.length > 0) {
          // Start from the filtered template (leaves only) and add the
          // nested-stack rows back with DeletionPolicy: Retain + rewritten
          // TemplateURL pointing at the child's AWS-side template (fetched
          // via GetTemplate(Processed)).
          const phase1BTemplate = filterTemplateForImport(plan.template, plan.phase1Imports, false);
          injectDeletionPolicyForImport(phase1BTemplate);
          const phase1BResources: ResourceToImport[] = [];

          for (const row of plan.nestedStackRows) {
            const childArn = cfnArnByCdkdName.get(row.childStackName);
            if (!childArn) {
              // Defensive cdkd-bug guard, intentionally untested: unreachable
              // via the normal flow. `flattenCdkdStateTreeLeafFirst` guarantees
              // every nested child is IMPORTed (and recorded in
              // `cfnArnByCdkdName`) before its parent's Phase 1B runs, and
              // `buildImportPlan` derives `row.childStackName` from the same
              // `state.resources` nested entries the tree walk reads — so a
              // recorded-ARN miss can only arise if those two invariants
              // diverge in a future refactor. The leaf-first ordering itself is
              // covered by the 3-level-tree test (Grandchild → Middle → Root
              // CreateChangeSet order) in export-nested-loop.test.ts.
              throw new Error(
                `runPerStackImportLoop: nested-stack child '${row.childStackName}' has no ` +
                  `recorded CFn ARN when processing parent '${plan.cdkdName}'. Leaf-first ` +
                  `iteration order should have IMPORTed the child first — this is a cdkd bug.`
              );
            }
            const childCfnName = cfnStackNameOf(row.childStackName);

            // Fetch the just-IMPORTed child's current template (AWS-side
            // canonicalized) and upload it to the cdkd state bucket so the
            // parent's nested-stack row's `TemplateURL` points at the
            // template AWS actually has on file for the child stack — the
            // AWS-docs "Nest an existing stack" template-match requirement.
            const childTemplateBody = await fetchCfnStackTemplate(deps.cfnClient, childCfnName);
            const uploaded = await uploadCfnTemplate({
              bucket: deps.uploadOpts.stateBucket,
              body: childTemplateBody,
              stackName: `${plan.cdkdName}__nested__${row.logicalId}`,
              // GetTemplate(Processed) always returns JSON regardless of
              // the original synth format; the codec accepts either.
              format: 'json',
              ...(deps.uploadOpts.s3ClientOpts && { s3ClientOpts: deps.uploadOpts.s3ClientOpts }),
            });
            uploadCleanups.push(uploaded.cleanup);

            // Fetch the child stack's CURRENT tags — the parent's
            // nested-stack row's `Properties.Tags` must match these per
            // AWS's "Nested stack import validation" (otherwise the
            // changeset fails at execute time with "Tags of resource
            // [<id>] defined in the template don't match..."). The
            // child's tags include the temporary `cdkd:nested-export-flip`
            // tag added by `flipStackToUpdateComplete`; forwarding them
            // verbatim ensures the parent template's row matches the
            // AWS-side reality at adoption time.
            const childTagsDesc = await deps.cfnClient.send(
              new DescribeStacksCommand({ StackName: childCfnName })
            );
            const childActualTags = childTagsDesc.Stacks?.[0]?.Tags ?? [];

            const originalRow = getResourceFromTemplate(plan.template, row.logicalId);
            if (!originalRow) {
              // Defensive cdkd-bug guard, intentionally untested: unreachable
              // via the normal flow. `row.logicalId` comes from
              // `buildImportPlan(plan.template)`, which produced this
              // nested-stack row by iterating `plan.template.Resources` — so a
              // re-read of the same template object is guaranteed to find it.
              // A miss can only arise if `plan.template` is mutated between
              // plan-build and this read, which the orchestrator never does.
              throw new Error(
                `runPerStackImportLoop: parent template for '${plan.cdkdName}' has no ` +
                  `resource '${row.logicalId}'. State and template are out of sync.`
              );
            }
            const rewrittenRow = injectRetainAndRewriteTemplateUrl(
              originalRow,
              uploaded.url,
              childActualTags
            );
            (phase1BTemplate['Resources'] as Record<string, unknown>)[row.logicalId] = rewrittenRow;
            rewrittenNestedRows.set(row.logicalId, rewrittenRow);

            phase1BResources.push({
              ResourceType: NESTED_STACK_RESOURCE_TYPE,
              LogicalResourceId: row.logicalId,
              ResourceIdentifier: { StackId: childArn },
            });
          }

          try {
            // Phase 1B's outer template is serialized in the user's synth
            // format (`plan.templateFormat` — may be YAML when the user passed
            // `--template foo.yaml`), while each nested-child `TemplateURL` it
            // references points at a JSON body (GetTemplate(Processed) always
            // returns JSON, uploaded with `format: 'json'` above). AWS detects
            // each URL's format independently of the outer template's, so the
            // mixed YAML-parent / JSON-child shape is intentional and safe.
            await submitImportChangeSet(
              deps.cfnClient,
              plan.cfnName,
              phase1BTemplate,
              phase1BResources,
              stackParameters,
              plan.templateFormat,
              deps.uploadOpts
            );
          } catch (err) {
            // Phase 1A already succeeded — the parent CFn stack exists with
            // its leaf resources. Phase 1B (nested adoption) failed. The
            // child stack(s) are also standalone CFn stacks at this point
            // (from prior iterations). cdkd state is preserved across the
            // tree so the user can recover.
            const importedSummary =
              importedStacks.length > 0
                ? importedStacks.map((s) => `${s.cdkdStackName} → ${s.cfnStackName}`).join(', ')
                : '(none)';
            throw new Error(
              `Phase 1B (nested-child adoption) IMPORT changeset failed for parent ` +
                `'${plan.cdkdName}' (CFn name '${plan.cfnName}'). The parent CFn stack ` +
                `exists with its ${plan.phase1Imports.length} leaf resource(s); ` +
                `${plan.nestedStackRows.length} nested-child adoption(s) did NOT complete. ` +
                `Stacks IMPORTed so far (each is a standalone CFn stack): ${importedSummary}. ` +
                `cdkd state for every stack in the tree is preserved. To recover: (1) fix the ` +
                `underlying cause (typically a template-match validation error per AWS-docs ` +
                `"Nested stack import validation"); (2) clear cdkd state for the migrated stacks ` +
                `via 'cdkd state orphan <stack>' (do NOT 'cdkd destroy' — that would tear down ` +
                `the live AWS resources); (3) re-attempt the parent-side nested adoption ` +
                `manually via the AWS console or CLI per the AWS docs procedure. ` +
                `Cause: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err instanceof Error ? err : undefined }
            );
          }
          logger.info(
            `  ✓ Phase 1B: parent '${plan.cfnName}' adopted ${plan.nestedStackRows.length} ` +
              `nested child(ren) via UPDATE-IMPORT.`
          );

          // Phase 1B's UPDATE-IMPORT leaves the parent in IMPORT_COMPLETE
          // again. Flip back to UPDATE_COMPLETE if this parent will itself
          // be adopted by its OWN parent in a later iteration (i.e. it's
          // not the root). For the root, the migration is over after
          // Phase 1B — no further flip needed.
          if (plan.cdkdName !== rootStackName) {
            logger.info(
              `  Flipping '${plan.cfnName}' back to UPDATE_COMPLETE so its own parent's ` +
                `Phase 1B can adopt it...`
            );
            await flipStackToUpdateComplete(deps.cfnClient, plan.cfnName, stackParameters);
          }
        }

        // ---- Per-stack pre-delete + phase 2 UPDATE ----
        if (plan.recreateBeforePhase2.length > 0) {
          for (const entry of plan.recreateBeforePhase2) {
            const handler = PRE_DELETE_HANDLERS[entry.resourceType];
            if (!handler) {
              throw new Error(
                `No pre-delete handler registered for ${entry.resourceType} ` +
                  `(${entry.logicalId}) in stack '${plan.cdkdName}'. This is a cdkd bug — the ` +
                  `resource is in IMPORT_UNSUPPORTED_RECREATABLE_TYPES but lacks a ` +
                  `PRE_DELETE_HANDLERS entry.`
              );
            }
            logger.info(
              `  Pre-deleting AWS resource for ${entry.logicalId} (${entry.resourceType}) ` +
                `so CFn can re-CREATE in phase 2...`
            );
            await handler(entry);
            logger.info(`    ✓ deleted ${entry.physicalId}`);
          }
        }

        const stackPhase2Count = plan.phase2Creates.length + plan.recreateBeforePhase2.length;
        if (stackPhase2Count > 0) {
          // Phase-2 template must include the nested-stack rows we
          // injected (so CFn does not try to remove them) AND must apply
          // the same conditional `ResourceIdentifier` overlay as phase-1
          // to avoid silent REPLACEMENT of any immutable Name property.
          // Start from `applyImportOverlayForPhase2`'s output (which
          // operates against the full template) and re-inject the
          // Retain-bearing nested-stack rows we constructed during
          // phase-1 — same `Properties.TemplateURL` rewrite so CFn
          // continues to see the AWS-canonicalized child template.
          const phase2Template = applyImportOverlayForPhase2(plan.template, plan.phase1Imports);
          for (const row of plan.nestedStackRows) {
            const overlaidResources = phase2Template['Resources'] as Record<string, unknown>;
            const rewrittenRow = rewrittenNestedRows.get(row.logicalId);
            if (rewrittenRow !== undefined) {
              overlaidResources[row.logicalId] = rewrittenRow;
            }
          }
          await executeUpdateChangeSet(
            deps.cfnClient,
            plan.cfnName,
            phase2Template,
            stackParameters,
            plan.templateFormat,
            deps.uploadOpts
          );
          logger.info(
            `  ✓ Phase 2: stack '${plan.cfnName}' updated ` +
              `(${plan.phase2Creates.length} non-importable CREATE, ` +
              `${plan.recreateBeforePhase2.length} re-CREATE).`
          );
        }
      }

      // ---- All stacks IMPORTed: delete cdkd state leaf-first ----
      // At this point every stack in the tree is CFn-managed. State
      // deletion is best-effort: a transient S3 error on the Nth call
      // would leave the first N-1 states deleted while the rest persist,
      // and re-running `cdkd export` would then hit `assertCfnStackAbsent`
      // for the already-migrated stacks with no hint of partial state.
      // Collect failures and re-throw with a summary so the user can
      // either re-run state deletion manually (via `cdkd state orphan
      // <stack>` per remaining record) or accept the orphan state until
      // their next manual cleanup. AWS-side state is unchanged either
      // way — every stack is CFn-managed, the migration succeeded.
      const stateDeletionFailures: Array<{ stackName: string; region: string; reason: string }> =
        [];
      for (const node of leafFirst) {
        try {
          await deps.stateBackend.deleteState(node.stackName, node.region);
          logger.info(`cdkd state for '${node.stackName}' (${node.region}) removed.`);
        } catch (err) {
          stateDeletionFailures.push({
            stackName: node.stackName,
            region: node.region,
            reason: err instanceof Error ? err.message : String(err),
          });
          logger.warn(
            `Failed to delete cdkd state for '${node.stackName}' (${node.region}): ` +
              `${err instanceof Error ? err.message : String(err)}. ` +
              `The stack IS CFn-managed; clean up with 'cdkd state orphan ${node.stackName}'.`
          );
        }
      }
      if (stateDeletionFailures.length > 0) {
        // The per-failure warnings already named each affected stack;
        // throw a summary so the orchestrator's caller can surface a
        // non-zero exit code (the migration succeeded AWS-side but
        // partial state remains under cdkd).
        const lines = stateDeletionFailures
          .map((f) => `  - cdkd/${f.stackName}/${f.region}/state.json: ${f.reason}`)
          .join('\n');
        throw new Error(
          `${stateDeletionFailures.length} cdkd state record(s) could not be deleted after a ` +
            `successful per-stack IMPORT loop. Every stack in the tree IS CFn-managed (the ` +
            `migration succeeded AWS-side); orphan state remains under:\n${lines}\n` +
            `Recover with 'cdkd state orphan <stack>' per record.`
        );
      }

      // Aggregate summary of intrinsic-valued Parameters that could NOT be
      // resolved across the tree (cdkd resolves `Ref` / `Fn::GetAtt` against
      // the parent's state up front; this lists only the residue the
      // resolver could not handle). The per-stack warns above scroll past
      // under `--yes`; re-print a single consolidated line at the end so the
      // user has one place to confirm every affected child's template carries
      // the needed Parameter Default values (CFn rejects the IMPORT otherwise).
      if (sessionIntrinsicSkipped.size > 0) {
        const detail = [...sessionIntrinsicSkipped.entries()]
          .map(([cdkdName, params]) => `${cdkdName} (${params.join(', ')})`)
          .join('; ');
        logger.warn(
          `${sessionIntrinsicSkipped.size} stack(s) had intrinsic-valued Parameter(s) that cdkd ` +
            `could not resolve at IMPORT time: ${detail}. Verify each child template's Parameter ` +
            `Default values cover these before the first 'cdk deploy'.`
        );
      }

      return { outcome: 'success', importedStacks };
    } finally {
      // Drain transient template uploads. Each cleanup is best-effort:
      // the transient object lives under the `cdkd-migrate-tmp/` prefix
      // and can be reaped manually. CFn has already copied the child
      // templates into its own internal storage during CreateChangeSet,
      // so the S3 objects are no longer load-bearing after the loop.
      for (const cleanup of uploadCleanups) {
        await runTemplateUploadCleanup(cleanup, deps.uploadOpts.stateBucket);
      }
    }
  } finally {
    // Release per-non-root-child locks in reverse acquire order. The
    // outer `exportCommand` releases the root's lock in its own finally.
    for (let i = acquiredChildLocks.length - 1; i >= 0; i--) {
      const lock = acquiredChildLocks[i]!;
      await deps.lockManager.releaseLock(lock.stackName, lock.region).catch((err) => {
        logger.warn(
          `Failed to release lock for '${lock.stackName}' (${lock.region}): ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }
}

/**
 * Helper for {@link runPerStackImportLoop}: pull a single resource out of
 * a template's Resources block by logical id, returning `undefined` if
 * the template is malformed or the resource is absent.
 */
function getResourceFromTemplate(
  template: Record<string, unknown>,
  logicalId: string
): Record<string, unknown> | undefined {
  const resources = template['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return undefined;
  const r = (resources as Record<string, unknown>)[logicalId];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  return r as Record<string, unknown>;
}

/**
 * Helper for {@link runPerStackImportLoop}'s non-leaf-parent branch:
 * mutate-clone a nested-stack resource row to (a) inject `DeletionPolicy:
 * Retain` (AWS-docs "Nest an existing stack" requirement so a parent-side
 * rollback does NOT cascade-delete the just-imported child stack), (b)
 * overwrite `Properties.TemplateURL` to the uploaded child template's S3
 * URL, and (c) overwrite `Properties.Tags` with the child stack's actual
 * current tags. The Tags overwrite is required by AWS's "Nested stack
 * import validation": "The tags for the nested AWS::CloudFormation::Stack
 * definition in the parent stack template match the tags for the actual
 * nested stack resource." Without the overwrite, the parent's IMPORT
 * changeset fails with `Tags of resource [<id>] defined in the template
 * don't match with the actual tags of <arn>` — most commonly when
 * {@link flipStackToUpdateComplete} added a `cdkd:nested-export-flip`
 * tag to the child to escape the IMPORT_COMPLETE status. All other
 * Properties (Parameters, NotificationARNs) are preserved from the
 * original row.
 *
 * `childActualTags` is the result of `DescribeStacks(<child>).Stacks[0].Tags`
 * (empty array if the child has no tags). When the child has no actual
 * tags AND the original row has no Tags Properties either, the
 * Properties.Tags key is omitted from the output so the parent template
 * stays minimal (matches the CDK-synth shape for tag-free stacks).
 *
 * Exported for unit testing.
 */
export function injectRetainAndRewriteTemplateUrl(
  originalRow: Record<string, unknown>,
  newTemplateUrl: string,
  childActualTags?: ReadonlyArray<CfnTag>
): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...originalRow };
  cloned['DeletionPolicy'] = 'Retain';
  const existingProps = cloned['Properties'];
  const properties: Record<string, unknown> =
    existingProps && typeof existingProps === 'object' && !Array.isArray(existingProps)
      ? { ...(existingProps as Record<string, unknown>) }
      : {};
  properties['TemplateURL'] = newTemplateUrl;
  if (childActualTags && childActualTags.length > 0) {
    // Forward every user-set tag verbatim — AWS validates the full list,
    // not a subset. EXCLUDE tags whose Key starts with `aws:` (e.g.
    // `aws:cloudformation:stack-id` / `aws:cloudformation:stack-name`
    // auto-added by AWS Service Catalog / StackSets to their managed
    // stacks). CFn rejects user-supplied tags whose Key starts with
    // `aws:` with `Tags starting with 'aws:' are reserved`, so a child
    // re-imported into cdkd from a Service-Catalog-deployed source
    // would otherwise break Phase 1B's adoption changeset with a
    // confusing rejection. AWS's "Nested stack import validation"
    // accepts the absence of system tags from the parent template
    // (they live only AWS-side and are auto-reattached). Also strip
    // undefined Key/Value entries (defensive: SDK types these as
    // optional even though AWS never returns them blank).
    const forwardable = childActualTags.filter(
      (t) => t.Key !== undefined && t.Value !== undefined && !t.Key.startsWith('aws:')
    );
    if (forwardable.length > 0) {
      properties['Tags'] = forwardable.map((t) => ({ Key: t.Key, Value: t.Value }));
    }
  }
  cloned['Properties'] = properties;
  return cloned;
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
export async function executeUpdateChangeSet(
  cfnClient: AwsClients['cloudFormation'],
  stackName: string,
  template: Record<string, unknown>,
  parameters: Parameter[],
  templateFormat: TemplateFormat = 'json',
  uploadOpts?: ChangeSetUploadOpts
): Promise<void> {
  const logger = getLogger();
  const changeSetName = `cdkd-phase2-${Date.now()}`;
  const templateBody = stringifyCfnTemplate(template, templateFormat);

  logger.info(
    `Creating UPDATE changeset '${changeSetName}' for phase 2 ` +
      `(${templateBody.length} bytes)...`
  );

  // Same size routing as phase-1 IMPORT: <= 51,200 inline; > 51,200 and
  // <= 1,048,576 via TemplateURL upload; > 1,048,576 pre-flight refuse.
  // Phase-2 is the typical wire-format limit trigger because it submits
  // the FULL synth template (phase-1 only submits the importable subset).
  const source = await selectChangeSetTemplateSource(
    template,
    templateBody,
    uploadOpts,
    stackName,
    'Phase-2 UPDATE',
    templateFormat
  );

  try {
    try {
      await cfnClient.send(
        new CreateChangeSetCommand({
          StackName: stackName,
          ChangeSetName: changeSetName,
          ChangeSetType: 'UPDATE',
          ...(source.kind === 'inline'
            ? { TemplateBody: source.templateBody }
            : { TemplateURL: source.templateUrl }),
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
        // Changeset creation settles in seconds; the SDK default cadence (30s
        // first poll) would dominate the wait (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 600, minDelay: 2, maxDelay: 5 },
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
        // Minutes-scale CFn operation: 10s polling is dense enough and stays
        // within the repo-wide waiter cap (issue #1291 item 5).
        { client: cfnClient, maxWaitTime: 3600, minDelay: 5, maxDelay: 10 },
        { StackName: stackName }
      );
    } catch (err) {
      await cfnClient
        .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
        .catch(() => {});
      throw err;
    }
  } finally {
    // Always run the upload cleanup (no-op for the inline path) so the
    // transient S3 object is removed regardless of CFn success / failure.
    await runTemplateUploadCleanup(source.cleanup, uploadOpts?.stateBucket ?? '');
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
        'Accepts JSON and YAML templates (YAML via a CFn-aware codec that preserves ' +
        '!Ref / !GetAtt / !Sub shorthand). Aborts if any resource is not CFn-importable.'
    )
    .argument('[stack]', 'Stack name to export (auto-detected for single-stack apps)')
    .option(
      '--cfn-stack-name <name>',
      'Name of the destination CloudFormation stack for the root stack. Defaults to the ' +
        "cdkd stack name (or the cdkd2cfnStackName mapping when the name contains '~'). " +
        'For per-nested-child overrides, use --cfn-child-stack-name.'
    )
    .option(
      '--cfn-child-stack-name <pair...>',
      "Per-nested-child CFn stack-name override. Repeatable. Format: '<cdkdName>=<cfnName>' " +
        "(e.g. --cfn-child-stack-name 'MyApp~Database=my-app-db'). The cdkd stack name for a " +
        "nested child is '<parent>~<childLogicalId>' (v6 state-key form). Without an override " +
        "the CFn name is derived by replacing '~' with '-'. Only consulted when the exported " +
        'stack tree contains nested children; ignored for flat stacks.'
    )
    .option(
      '--template <path>',
      'Path to a pre-rendered CloudFormation template (JSON or YAML — format auto-detected). Skips synth.'
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
        'exporting stack via Fn::GetStackOutput. Without the flag, cdkd warns and ' +
        'proceeds — the consumers keep resolving via the CloudFormation fallback ' +
        '(weak reference) unless they deploy with --no-cfn-fallback.',
      false
    )
    .option(
      '--skip-import-support-preflight',
      'Skip the pre-flight that refuses resource types whose CloudFormation registry ' +
        'schema says CFn cannot IMPORT them (no read handler AND NON_PROVISIONABLE), and ' +
        'let CreateChangeSet answer instead. The pre-flight is a registry HEURISTIC, not ' +
        "AWS's supported-for-import list, so this is the escape hatch for a type AWS has " +
        'since made importable. Expect the changeset to be rejected if the heuristic was ' +
        'right.',
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
