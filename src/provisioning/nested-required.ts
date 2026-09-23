/**
 * Pre-flight rule: a PRESENT nested property block must carry every member its
 * schema definition lists as `required` (issue
 * [#1802](https://github.com/go-to-k/cdkd/issues/1802)).
 *
 * CloudFormation refuses such a block before it touches AWS. cdkd forwarded
 * it, and where the service API replaces the nested struct wholesale the
 * result was a silent change to a live setting: a kept
 * `AWS::ECS::Service.DeploymentConfiguration.DeploymentCircuitBreaker` without
 * `Rollback` flipped the live `rollback` from true to false. Cloud Control
 * validates against the same schema server-side, so the gap is SDK-provider
 * scoped; running the check for every resource is correct-but-redundant on the
 * Cloud Control route. Same layer and same reasons as
 * {@link ./mutually-exclusive-properties}: pre-flight runs on every deploy, not
 * only when the provider is called.
 *
 * ## Refuse only what CloudFormation refuses
 *
 * - An ABSENT block is never a violation — only a present one missing a member.
 * - Pre-flight runs BEFORE intrinsic resolution, so any value along the path
 *   that is an unresolved intrinsic (`Fn::If`, `Ref`, ...) is UNKNOWN and its
 *   subtree is skipped. A member is present when its KEY is, whatever the value
 *   (`false`, `0`, `null`, or an intrinsic that may resolve to
 *   `AWS::NoValue`). Every doubt passes through: a false refusal blocks a valid
 *   deploy with no escape hatch, a missed one reaches AWS as it did before.
 * - {@link CFN_ENFORCED_TYPES} gates the whole check. A schema's `required`
 *   list is NOT evidence that CloudFormation enforces it: measured, CFn accepted
 *   an `AWS::Logs::LogGroup` tag with neither `Key` nor `Value`, and sent an
 *   `AWS::EC2::SecurityGroup` ingress rule without `IpProtocol` to the EC2 API.
 *
 * ## No override flag, by design
 *
 * The violation is in the TEMPLATE, CloudFormation rejects it too, and the
 * remedy (declare the missing member) is always available.
 */
import { hasOwnKey } from '../utils/own-keys.js';
import { NESTED_REQUIRED } from './nested-required.generated.js';

/**
 * Types whose nested `required` lists CloudFormation was MEASURED to enforce.
 * One template per type declared
 * every nested block of `NESTED_REQUIRED` empty; a type is listed only when
 * CloudFormation refused EVERY missing member the table predicts:
 *
 * - 64 types by early validation of a CREATE change set (nothing provisioned):
 *   `PROPERTY_VALIDATION` / "Required property [X] not found".
 * - 7 types early validation passed, refused at execution before any API call:
 *   `Model validation failed` / `Properties validation failed` /
 *   `Property validation failure` (ECS Service + TaskDefinition, EFS
 *   AccessPoint, Lambda EventSourceMapping, Step Functions StateMachine,
 *   API Gateway Method, AppSync GraphQLApi).
 * - 7 types with no registry handler, refused at execution by CloudFormation's
 *   own `Property validation failure` list (Budgets Budget, CloudWatch
 *   AnomalyDetector, CodeBuild Project, DocDB DBCluster + DBInstance, FSx
 *   FileSystem, Glue Table).
 *
 * Measured NOT enforced by a schema check (a handler or service error instead,
 * or an accepted create): ApiGatewayV2 Route, CloudFormation Stack, EC2
 * SecurityGroup, ECR Repository, EFS FileSystem, ELBv2 Listener, KMS Key,
 * KinesisFirehose DeliveryStream, Logs LogGroup, Route53 HostedZone, WAFv2
 * WebACL. Left out because CloudFormation reports only the FIRST missing member
 * (`Property X cannot be empty.`), so the rest of the table was not confirmed:
 * EMR Cluster, InstanceFleetConfig, InstanceGroupConfig. A type in none of
 * these lists (added later) is not checked until it is measured.
 */
export const CFN_ENFORCED_TYPES: ReadonlySet<string> = new Set([
  'AWS::ApiGateway::Deployment',
  'AWS::ApiGateway::Method',
  'AWS::ApiGateway::Stage',
  'AWS::AppSync::DataSource',
  'AWS::AppSync::GraphQLApi',
  'AWS::AppSync::Resolver',
  'AWS::AutoScaling::AutoScalingGroup',
  'AWS::BedrockAgentCore::Evaluator',
  'AWS::BedrockAgentCore::Runtime',
  'AWS::Budgets::Budget',
  'AWS::CertificateManager::Certificate',
  'AWS::CloudFront::CloudFrontOriginAccessIdentity',
  'AWS::CloudFront::Distribution',
  'AWS::CloudFront::OriginAccessControl',
  'AWS::CloudTrail::Trail',
  'AWS::CloudWatch::Alarm',
  'AWS::CloudWatch::AnomalyDetector',
  'AWS::CodeBuild::Project',
  'AWS::CodeCommit::Repository',
  'AWS::Cognito::UserPool',
  'AWS::DLM::LifecyclePolicy',
  'AWS::DocDB::DBCluster',
  'AWS::DocDB::DBInstance',
  'AWS::DocDB::DBSubnetGroup',
  'AWS::DynamoDB::GlobalTable',
  'AWS::DynamoDB::Table',
  'AWS::EC2::EIP',
  'AWS::EC2::Instance',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::NatGateway',
  'AWS::EC2::NetworkAcl',
  'AWS::EC2::RouteTable',
  'AWS::EC2::Subnet',
  'AWS::EC2::VPC',
  'AWS::ECS::Service',
  'AWS::ECS::TaskDefinition',
  'AWS::EFS::AccessPoint',
  'AWS::ElastiCache::CacheCluster',
  'AWS::ElastiCache::SubnetGroup',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
  'AWS::Events::EventBus',
  'AWS::Events::Rule',
  'AWS::FSx::FileSystem',
  'AWS::Glue::Connection',
  'AWS::Glue::Table',
  'AWS::Glue::Trigger',
  'AWS::IAM::Group',
  'AWS::IAM::Role',
  'AWS::IAM::User',
  'AWS::Kinesis::Stream',
  'AWS::Kinesis::StreamConsumer',
  'AWS::Lambda::EventInvokeConfig',
  'AWS::Lambda::EventSourceMapping',
  'AWS::Lambda::Function',
  'AWS::Lambda::LayerVersion',
  'AWS::Lambda::MicrovmImage',
  'AWS::Neptune::DBCluster',
  'AWS::Neptune::DBInstance',
  'AWS::Neptune::DBSubnetGroup',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBSubnetGroup',
  'AWS::Route53::RecordSet',
  'AWS::S3::Bucket',
  'AWS::S3Express::DirectoryBucket',
  'AWS::S3Tables::Table',
  'AWS::S3Tables::TableBucket',
  'AWS::S3Vectors::VectorBucket',
  'AWS::SNS::Topic',
  'AWS::SQS::Queue',
  'AWS::Scheduler::Schedule',
  'AWS::SecretsManager::Secret',
  'AWS::ServiceDiscovery::HttpNamespace',
  'AWS::ServiceDiscovery::PrivateDnsNamespace',
  'AWS::ServiceDiscovery::PublicDnsNamespace',
  'AWS::ServiceDiscovery::Service',
  'AWS::StepFunctions::StateMachine',
]);

/** One present nested block missing one or more required members. */
export interface NestedRequiredViolation {
  readonly resourceType: string;
  /** Where the block sits, array elements indexed: `Policies[0]`. */
  readonly path: string;
  /** The required members the block does not declare, sorted. */
  readonly missing: readonly string[];
}

/**
 * True for a single-key object whose key is `Ref` or `Fn::*`. The same
 * predicate as `mutually-exclusive-properties.ts` keeps local, for the same
 * reason: the modules answer different questions about the shape.
 */
function isUnresolvedIntrinsic(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

/** A plain object whose members can be checked: not an array, not an intrinsic. */
function isConcreteObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isUnresolvedIntrinsic(value)
  );
}

/**
 * Find every present nested block of this resource that lacks a required
 * member. `table` defaults to the generated one gated by
 * {@link CFN_ENFORCED_TYPES}; tests pass their own to reach every shape.
 */
export function findNestedRequiredViolations(
  resourceType: string,
  templateProperties: Record<string, unknown> | undefined,
  table: ReadonlyMap<string, readonly string[]> | undefined = CFN_ENFORCED_TYPES.has(resourceType)
    ? NESTED_REQUIRED.get(resourceType)
    : undefined
): NestedRequiredViolation[] {
  if (!table || !isConcreteObject(templateProperties)) return [];
  const violations: NestedRequiredViolation[] = [];
  for (const [path, required] of table) {
    const segments = path.split('.');
    const check = (value: unknown, display: string): void => {
      if (Array.isArray(value)) {
        value.forEach((element, i) => check(element, `${display}[${i}]`));
        return;
      }
      if (!isConcreteObject(value)) return;
      const missing = required.filter((member) => !hasOwnKey(value, member));
      if (missing.length > 0) violations.push({ resourceType, path: display, missing });
    };
    const visit = (value: unknown, depth: number, display: string): void => {
      if (depth === segments.length) {
        check(value, display);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((element, i) => visit(element, depth, `${display}[${i}]`));
        return;
      }
      if (!isConcreteObject(value)) return;
      const segment = segments[depth]!;
      if (!hasOwnKey(value, segment)) return;
      visit(value[segment], depth + 1, display ? `${display}.${segment}` : segment);
    };
    visit(templateProperties, 0, '');
  }
  return violations;
}

/** Render one violation as a per-resource error line. */
export function buildNestedRequiredMessage(
  logicalId: string,
  violation: NestedRequiredViolation
): string {
  return (
    `  - ${logicalId} (${violation.resourceType}): ${violation.path} is missing ` +
    `required ${violation.missing.length === 1 ? 'member' : 'members'} ${violation.missing.join(', ')}`
  );
}
