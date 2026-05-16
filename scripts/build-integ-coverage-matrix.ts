#!/usr/bin/env node
/**
 * scripts/build-integ-coverage-matrix.ts
 *
 * Builds a `(SDK Provider resource type) -> (integ fixture)` coverage
 * map by:
 *   1. Parsing src/provisioning/register-providers.ts for the set of
 *      registered AWS::Service::Type resource types.
 *   2. Scanning every tests/integration/<fixture>/lib/*.ts and
 *      tests/integration/<fixture>/bin/*.ts file for usages of those
 *      types via three signals:
 *        - L1 form:        new <ns>.Cfn<TypeName>(...)
 *        - Literal string: 'AWS::Service::Type' anywhere in the file
 *        - L2 form:        new <ns>.<Construct>(...) against a curated
 *                          L2 -> L1 lookup table (CDK_L2_TO_L1).
 *
 * The L2 table is intentionally a curated lower bound: a missed L2
 * construct produces a false-negative ("type appears uncovered when it
 * is") which surfaces in the docs/integ-coverage.md report and can be
 * patched here. Building the matrix from `cdk synth` per fixture would
 * be more accurate but is too slow for a pre-commit / CI gate.
 *
 * Outputs:
 *   - docs/_generated/integ-coverage.json: machine-readable matrix.
 *   - docs/integ-coverage.md:               markdown report.
 *
 * Run from the repo root:
 *   node --experimental-strip-types scripts/build-integ-coverage-matrix.ts
 *   (or: vp run integ-coverage)
 *
 * Used by:
 *   - .claude/hooks/provider-integ-gate.sh (consumes the json output
 *     to know which integs cover a given resource type).
 *   - Manual invocation when adding a new provider / integ fixture.
 *
 * Known limitations (decisions made during PR #404 review — review the
 * docs/_generated/integ-coverage.json output if any of these become
 * load-bearing for a particular type):
 *
 *   1. `CDK_L2_TO_L1` omits direct `new ec2.Subnet(...)` / `new
 *      ec2.RouteTable(...)` / `new ec2.Route(...)` etc. constructors
 *      that some fixtures could in principle use bare. The map covers
 *      `ec2.Vpc` (which wraps all of them via the L2 expansion) and
 *      that catches the practical-100% case. If a fixture surfaces
 *      that uses bare `ec2.Subnet`, either add the entry here or add
 *      a `// covers: AWS::EC2::Subnet` documentation comment to the
 *      fixture.
 *
 *   2. `scanLiteralTypes` matches any quoted-OR-bare `AWS::Service::Type`
 *      token anywhere in a fixture file — including in code comments
 *      like `// TODO: also handle AWS::Foo::Bar later`. This is by
 *      design ("contributor-asserted coverage" contract): a documentation
 *      comment claiming a fixture covers a type counts. A false claim
 *      is a documentation lie, not a hidden orphan; the matrix does
 *      not verify the claim and never will.
 *
 *   3. `ec2.Vpc` in `CDK_L2_TO_L1` unconditionally expands to include
 *      `AWS::EC2::NatGateway` — but CDK's L2 only creates a NAT GW when
 *      `natGateways` is omitted / non-zero. A fixture that passes
 *      `{natGateways: 0}` over-claims NatGateway coverage. The same
 *      `ec2.Vpc` expansion is widely covered (~19 fixtures), so the
 *      practical impact is nil; the matrix's NatGateway "covered" count
 *      is a slight upper bound. If the over-claim becomes load-bearing
 *      (a real NatGateway regression reaches main because cdkd thought
 *      it had coverage), tighten the expansion table here.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const REGISTER_FILE = join(REPO_ROOT, 'src/provisioning/register-providers.ts');
const ALLOWLIST_FILE = join(REPO_ROOT, '.claude/integ-coverage-allowlist.json');
const INTEG_DIR = join(REPO_ROOT, 'tests/integration');
const OUTPUT_JSON = join(REPO_ROOT, 'docs/_generated/integ-coverage.json');
const OUTPUT_MD = join(REPO_ROOT, 'docs/integ-coverage.md');

/**
 * Mapping from CDK module alias (the lowercase name in the import
 * line `import * as <alias> from 'aws-cdk-lib/aws-<service>'`) to the
 * AWS service segment in the CFn type id (`AWS::<Service>::<Type>`).
 *
 * Most CDK modules align to a single AWS service via a predictable
 * casing rule (`logs` -> `Logs`, `dynamodb` -> `DynamoDB`), but enough
 * exceptions exist that a static table is the only sane source of
 * truth (`elbv2` -> `ElasticLoadBalancingV2`, `sfn` -> `StepFunctions`).
 *
 * Only modules referenced by registered providers need entries here;
 * unknown aliases are silently skipped during scanning.
 */
const CDK_MODULE_TO_AWS_SERVICE: Record<string, string> = {
  s3: 'S3',
  s3express: 'S3Express',
  s3vectors: 'S3Vectors',
  s3tables: 'S3Tables',
  lambda: 'Lambda',
  lambda_nodejs: 'Lambda',
  lambda_python: 'Lambda',
  apigateway: 'ApiGateway',
  apigatewayv2: 'ApiGatewayV2',
  apigatewayv2_authorizers: 'ApiGatewayV2',
  apigatewayv2_integrations: 'ApiGatewayV2',
  dynamodb: 'DynamoDB',
  iam: 'IAM',
  sqs: 'SQS',
  sns: 'SNS',
  sns_subscriptions: 'SNS',
  kms: 'KMS',
  ec2: 'EC2',
  cloudfront: 'CloudFront',
  cloudfront_origins: 'CloudFront',
  cloudwatch: 'CloudWatch',
  cloudwatch_actions: 'CloudWatch',
  logs: 'Logs',
  logs_destinations: 'Logs',
  cloudtrail: 'CloudTrail',
  cognito: 'Cognito',
  appsync: 'AppSync',
  events: 'Events',
  events_targets: 'Events',
  efs: 'EFS',
  ecr: 'ECR',
  ecr_assets: 'ECR',
  ecs: 'ECS',
  ecs_patterns: 'ECS',
  elbv2: 'ElasticLoadBalancingV2',
  elasticloadbalancingv2: 'ElasticLoadBalancingV2',
  elbv2_targets: 'ElasticLoadBalancingV2',
  elasticache: 'ElastiCache',
  glue: 'Glue',
  kinesis: 'Kinesis',
  kinesisfirehose: 'KinesisFirehose',
  firehose: 'KinesisFirehose',
  neptune: 'Neptune',
  docdb: 'DocDB',
  rds: 'RDS',
  route53: 'Route53',
  route53_targets: 'Route53',
  secretsmanager: 'SecretsManager',
  servicediscovery: 'ServiceDiscovery',
  ssm: 'SSM',
  stepfunctions: 'StepFunctions',
  stepfunctions_tasks: 'StepFunctions',
  sfn: 'StepFunctions',
  sfn_tasks: 'StepFunctions',
  wafv2: 'WAFv2',
  bedrock: 'Bedrock',
  bedrockagentcore: 'BedrockAgentCore',
  autoscaling: 'AutoScaling',
  applicationautoscaling: 'ApplicationAutoScaling',
  codebuild: 'CodeBuild',
};

/**
 * Curated L2 / L3 construct -> L1 CFn type mapping.
 *
 * Key form: `<module-alias>.<ConstructName>` (matches what shows up in
 * `new s3.Bucket(...)` or `new lambda.Function(...)` calls).
 *
 * Value: an array of CFn types the construct synthesizes. Most are
 * 1:1; complex L2s like RDS DatabaseCluster expand to several
 * (DBCluster + DBInstance + DBSubnetGroup).
 *
 * This is INTENTIONALLY conservative — only constructs that produce
 * a registered SDK provider's type are listed. A new entry only needs
 * adding when a contributor's integ uses an L2 wrapper that the
 * matrix can't see through.
 */
const CDK_L2_TO_L1: Record<string, string[]> = {
  // S3
  's3.Bucket': ['AWS::S3::Bucket'],
  's3.BucketPolicy': ['AWS::S3::BucketPolicy'],
  's3express.DirectoryBucket': ['AWS::S3Express::DirectoryBucket'],

  // Lambda
  'lambda.Function': ['AWS::Lambda::Function'],
  'lambda.DockerImageFunction': ['AWS::Lambda::Function'],
  'lambda_nodejs.NodejsFunction': ['AWS::Lambda::Function'],
  'lambda_python.PythonFunction': ['AWS::Lambda::Function'],
  'lambda.LayerVersion': ['AWS::Lambda::LayerVersion'],
  'lambda.FunctionUrl': ['AWS::Lambda::Url'],
  'lambda.EventSourceMapping': ['AWS::Lambda::EventSourceMapping'],
  'lambda.Permission': ['AWS::Lambda::Permission'],

  // DynamoDB
  'dynamodb.Table': ['AWS::DynamoDB::Table'],
  'dynamodb.TableV2': ['AWS::DynamoDB::GlobalTable'],

  // IAM
  'iam.Role': ['AWS::IAM::Role'],
  'iam.User': ['AWS::IAM::User'],
  'iam.Group': ['AWS::IAM::Group'],
  'iam.Policy': ['AWS::IAM::Policy'],
  'iam.InstanceProfile': ['AWS::IAM::InstanceProfile'],

  // SQS / SNS
  'sqs.Queue': ['AWS::SQS::Queue'],
  'sqs.QueuePolicy': ['AWS::SQS::QueuePolicy'],
  'sns.Topic': ['AWS::SNS::Topic'],
  'sns.Subscription': ['AWS::SNS::Subscription'],
  'sns.TopicPolicy': ['AWS::SNS::TopicPolicy'],

  // KMS
  'kms.Key': ['AWS::KMS::Key'],
  'kms.Alias': ['AWS::KMS::Alias'],

  // EC2
  'ec2.Vpc': [
    'AWS::EC2::VPC',
    'AWS::EC2::Subnet',
    'AWS::EC2::InternetGateway',
    'AWS::EC2::VPCGatewayAttachment',
    'AWS::EC2::RouteTable',
    'AWS::EC2::Route',
    'AWS::EC2::SubnetRouteTableAssociation',
    // NAT GW only when natGateways > 0; we assume default (1).
    'AWS::EC2::NatGateway',
  ],
  'ec2.SecurityGroup': ['AWS::EC2::SecurityGroup'],
  'ec2.Instance': ['AWS::EC2::Instance'],
  'ec2.NetworkAcl': ['AWS::EC2::NetworkAcl'],

  // ECS
  'ecs.Cluster': ['AWS::ECS::Cluster'],
  'ecs.FargateService': ['AWS::ECS::Service'],
  'ecs.Ec2Service': ['AWS::ECS::Service'],
  'ecs.FargateTaskDefinition': ['AWS::ECS::TaskDefinition'],
  'ecs.Ec2TaskDefinition': ['AWS::ECS::TaskDefinition'],
  'ecs.TaskDefinition': ['AWS::ECS::TaskDefinition'],
  'ecs_patterns.ApplicationLoadBalancedFargateService': [
    'AWS::ECS::Service',
    'AWS::ECS::TaskDefinition',
    'AWS::ECS::Cluster',
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::ElasticLoadBalancingV2::Listener',
    'AWS::ElasticLoadBalancingV2::TargetGroup',
  ],

  // EFS / ECR
  'efs.FileSystem': ['AWS::EFS::FileSystem', 'AWS::EFS::MountTarget'],
  'efs.AccessPoint': ['AWS::EFS::AccessPoint'],
  'ecr.Repository': ['AWS::ECR::Repository'],
  'ecr_assets.DockerImageAsset': ['AWS::ECR::Repository'],

  // CloudFront
  'cloudfront.Distribution': ['AWS::CloudFront::Distribution'],
  'cloudfront.CloudFrontWebDistribution': ['AWS::CloudFront::Distribution'],
  'cloudfront.OriginAccessIdentity': ['AWS::CloudFront::CloudFrontOriginAccessIdentity'],

  // EventBridge
  'events.Rule': ['AWS::Events::Rule'],
  'events.EventBus': ['AWS::Events::EventBus'],

  // API Gateway v1
  'apigateway.Method': ['AWS::ApiGateway::Method'],
  'apigateway.Resource': ['AWS::ApiGateway::Resource'],
  'apigateway.Stage': ['AWS::ApiGateway::Stage'],
  'apigateway.Authorizer': ['AWS::ApiGateway::Authorizer'],
  'apigateway.RequestAuthorizer': ['AWS::ApiGateway::Authorizer'],
  'apigateway.TokenAuthorizer': ['AWS::ApiGateway::Authorizer'],
  'apigateway.Deployment': ['AWS::ApiGateway::Deployment'],
  // RestApi pulls in many sub-resources; covered by Method/Stage/Deployment when explicit.

  // API Gateway v2 (HTTP API)
  'apigatewayv2.HttpApi': [
    'AWS::ApiGatewayV2::Api',
    'AWS::ApiGatewayV2::Stage',
    'AWS::ApiGatewayV2::Route',
    'AWS::ApiGatewayV2::Integration',
  ],
  'apigatewayv2.WebSocketApi': ['AWS::ApiGatewayV2::Api'],
  'apigatewayv2.HttpStage': ['AWS::ApiGatewayV2::Stage'],
  'apigatewayv2.WebSocketStage': ['AWS::ApiGatewayV2::Stage'],

  // Cognito
  'cognito.UserPool': ['AWS::Cognito::UserPool'],

  // Route 53
  'route53.HostedZone': ['AWS::Route53::HostedZone'],
  'route53.PrivateHostedZone': ['AWS::Route53::HostedZone'],
  'route53.PublicHostedZone': ['AWS::Route53::HostedZone'],
  'route53.ARecord': ['AWS::Route53::RecordSet'],
  'route53.CnameRecord': ['AWS::Route53::RecordSet'],
  'route53.AaaaRecord': ['AWS::Route53::RecordSet'],
  'route53.RecordSet': ['AWS::Route53::RecordSet'],
  'route53.TxtRecord': ['AWS::Route53::RecordSet'],

  // SecretsManager / SSM / Logs
  'secretsmanager.Secret': ['AWS::SecretsManager::Secret'],
  'ssm.StringParameter': ['AWS::SSM::Parameter'],
  'ssm.StringListParameter': ['AWS::SSM::Parameter'],
  'logs.LogGroup': ['AWS::Logs::LogGroup'],

  // CloudWatch
  'cloudwatch.Alarm': ['AWS::CloudWatch::Alarm'],
  'cloudwatch.MathExpression': [],

  // AppSync
  'appsync.GraphqlApi': ['AWS::AppSync::GraphQLApi'],

  // Kinesis / Firehose
  'kinesis.Stream': ['AWS::Kinesis::Stream'],

  // CloudTrail
  'cloudtrail.Trail': ['AWS::CloudTrail::Trail'],

  // CodeBuild
  'codebuild.Project': ['AWS::CodeBuild::Project'],
  'codebuild.PipelineProject': ['AWS::CodeBuild::Project'],

  // RDS / DocDB / Neptune
  'rds.DatabaseCluster': [
    'AWS::RDS::DBCluster',
    'AWS::RDS::DBInstance',
    'AWS::RDS::DBSubnetGroup',
  ],
  'rds.DatabaseInstance': ['AWS::RDS::DBInstance', 'AWS::RDS::DBSubnetGroup'],
  'rds.SubnetGroup': ['AWS::RDS::DBSubnetGroup'],
  'rds.ServerlessCluster': [
    'AWS::RDS::DBCluster',
    'AWS::RDS::DBSubnetGroup',
  ],
  'docdb.DatabaseCluster': [
    'AWS::DocDB::DBCluster',
    'AWS::DocDB::DBInstance',
    'AWS::DocDB::DBSubnetGroup',
  ],
  'neptune.DatabaseCluster': [
    'AWS::Neptune::DBCluster',
    'AWS::Neptune::DBInstance',
    'AWS::Neptune::DBSubnetGroup',
  ],

  // ElastiCache
  'elasticache.CfnSubnetGroup': ['AWS::ElastiCache::SubnetGroup'],
  'elasticache.CfnCacheCluster': ['AWS::ElastiCache::CacheCluster'],

  // ELBv2
  'elbv2.ApplicationLoadBalancer': ['AWS::ElasticLoadBalancingV2::LoadBalancer'],
  'elbv2.NetworkLoadBalancer': ['AWS::ElasticLoadBalancingV2::LoadBalancer'],
  'elbv2.ApplicationListener': ['AWS::ElasticLoadBalancingV2::Listener'],
  'elbv2.NetworkListener': ['AWS::ElasticLoadBalancingV2::Listener'],
  'elbv2.ApplicationTargetGroup': ['AWS::ElasticLoadBalancingV2::TargetGroup'],
  'elbv2.NetworkTargetGroup': ['AWS::ElasticLoadBalancingV2::TargetGroup'],
  'elasticloadbalancingv2.ApplicationLoadBalancer': ['AWS::ElasticLoadBalancingV2::LoadBalancer'],

  // Step Functions
  'stepfunctions.StateMachine': ['AWS::StepFunctions::StateMachine'],
  'sfn.StateMachine': ['AWS::StepFunctions::StateMachine'],

  // Service Discovery
  'servicediscovery.PrivateDnsNamespace': ['AWS::ServiceDiscovery::PrivateDnsNamespace'],
  'servicediscovery.Service': ['AWS::ServiceDiscovery::Service'],

  // AutoScaling
  'autoscaling.AutoScalingGroup': ['AWS::AutoScaling::AutoScalingGroup'],
};

interface CoverageEntry {
  resourceType: string;
  integs: string[];
  signals: Record<string, ('literal' | 'l1' | 'l2')[]>;
}

interface AllowListEntry {
  resourceType: string;
  rationale: string;
}

interface CoverageReport {
  // No `generatedAt` field on purpose — including a timestamp would
  // make every regeneration produce a diff (even when the underlying
  // coverage is unchanged), which trips the planned CI auto-regen
  // check (issue #399) and noisens PR review on every rebase.
  registeredTypes: string[];
  covered: CoverageEntry[];
  orphans: string[];
  allowListed: AllowListEntry[];
  unknownTypesInIntegs: string[];
}

export function parseRegisteredTypes(content: string): string[] {
  const re = /registry\.register\(\s*['"](AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)['"]/g;
  const types = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    types.add(m[1]);
  }
  return Array.from(types).sort();
}

/**
 * Read the allow-no-integ allow-list from
 * `.claude/integ-coverage-allowlist.json`. Each non-`$`-prefixed key is
 * an `AWS::Service::Type`, mapped to a non-empty rationale string.
 *
 * Why a sidecar (and not inline `// allow-no-integ:` comments on the
 * `registry.register(...)` lines): `src/provisioning/register-providers.ts`
 * is in the `integ-broad-gate.sh` cross-cutting scope. Editing inline
 * comments there would force a real-AWS broad integ run on every
 * allow-list update. The sidecar keeps allow-list edits decoupled from
 * the gate.
 *
 * Mirrors the hook's parsing rule: rationale must be a non-empty
 * string (whitespace-only does NOT exempt the type, so the matrix and
 * the hook agree on what counts as allow-listed). Keys starting with
 * `$` are documentation metadata (`$schema-doc`, `$why-sidecar`) and
 * are skipped.
 */
/**
 * Pure-functional parser for the allow-list sidecar JSON content. Split
 * from the file-reading wrapper for unit testability — tests pass JSON
 * strings directly without touching the filesystem.
 */
export function parseAllowNoIntegRationalesContent(jsonStr: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith('$')) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    out.set(key, trimmed);
  }
  return out;
}

export function parseAllowNoIntegRationales(): Map<string, string> {
  if (!existsSync(ALLOWLIST_FILE)) return new Map();
  let content: string;
  try {
    content = readFileSync(ALLOWLIST_FILE, 'utf8');
  } catch (e) {
    process.stderr.write(
      `integ-coverage: failed to read ${ALLOWLIST_FILE}: ${(e as Error).message}\n`
    );
    return new Map();
  }
  return parseAllowNoIntegRationalesContent(content);
}

export function listFixtures(integDir: string = INTEG_DIR): string[] {
  if (!existsSync(integDir)) return [];
  return readdirSync(integDir)
    .filter((name) => {
      // Ignore hidden directories (e.g. `.scratch/`, IDE folders); the
      // matrix is scoped to real integ fixtures only.
      if (name.startsWith('.')) return false;
      const full = join(integDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function listLibAndBinFiles(fixtureDir: string): string[] {
  const out: string[] = [];
  for (const sub of ['lib', 'bin']) {
    const dir = join(fixtureDir, sub);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts')) continue;
      const full = join(dir, entry);
      if (statSync(full).isFile()) out.push(full);
    }
  }
  return out;
}

export interface ImportAlias {
  alias: string;
  module: string;
}

/**
 * Extract `import * as <alias> from 'aws-cdk-lib/aws-<module>'` and
 * `import <alias> = require('aws-cdk-lib/aws-<module>')` lines from a
 * source file. Used to resolve `<alias>.Cfn<XYZ>` calls back to the
 * AWS service segment.
 */
export function parseImportAliases(content: string): ImportAlias[] {
  const out: ImportAlias[] = [];
  // `aws-cdk-lib/aws-<svc>` paths may contain hyphens (e.g.
  // `aws-stepfunctions-tasks`, `aws-events-targets`). Capture the
  // hyphenated tail, then normalize to underscores so the captured
  // module matches the underscore-keyed `CDK_MODULE_TO_AWS_SERVICE`
  // and `CDK_L2_TO_L1` tables.
  const re1 = /import\s+\*\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+from\s+['"]aws-cdk-lib\/aws-([a-zA-Z0-9_-]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(content)) !== null) {
    out.push({ alias: m[1], module: m[2].replace(/-/g, '_') });
  }
  // Named-imports form (e.g. `import { aws_s3 as s3 } from 'aws-cdk-lib'`).
  const re2 = /aws_([a-zA-Z0-9_]+)\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
  while ((m = re2.exec(content)) !== null) {
    out.push({ alias: m[2], module: m[1] });
  }
  return out;
}

/**
 * Detect L1 `Cfn*` constructs in the form `new <alias>.Cfn<TypeName>(`
 * and resolve to the matching `AWS::<Service>::<TypeName>` id via the
 * import aliases and `CDK_MODULE_TO_AWS_SERVICE` lookup.
 *
 * Returns the SET of types seen plus the per-type signal kind.
 */
export function scanL1Types(
  content: string,
  aliases: ImportAlias[]
): Map<string, 'l1'> {
  const aliasToService = new Map<string, string>();
  for (const { alias, module } of aliases) {
    const svc = CDK_MODULE_TO_AWS_SERVICE[module];
    if (svc) aliasToService.set(alias, svc);
  }
  if (aliasToService.size === 0) return new Map();

  const out = new Map<string, 'l1'>();
  const aliasUnion = Array.from(aliasToService.keys()).map(escapeRegex).join('|');
  if (!aliasUnion) return out;
  const re = new RegExp(
    `new\\s+(${aliasUnion})\\.Cfn([A-Z][A-Za-z0-9]*)\\s*\\(`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const svc = aliasToService.get(m[1]);
    if (!svc) continue;
    out.set(`AWS::${svc}::${m[2]}`, 'l1');
  }
  return out;
}

/**
 * Detect L2 / L3 constructs via the curated `CDK_L2_TO_L1` map.
 *
 * Each `new <alias>.<Construct>(` site is checked against
 * `<resolved-module>.<Construct>` (where `resolved-module` is the
 * import's module, e.g. `s3` for `import * as s3 from 'aws-cdk-lib/aws-s3'`).
 */
export function scanL2Types(
  content: string,
  aliases: ImportAlias[]
): Map<string, 'l2'> {
  const aliasToModule = new Map<string, string>();
  for (const { alias, module } of aliases) {
    aliasToModule.set(alias, module);
  }
  if (aliasToModule.size === 0) return new Map();

  const out = new Map<string, 'l2'>();
  const aliasUnion = Array.from(aliasToModule.keys()).map(escapeRegex).join('|');
  if (!aliasUnion) return out;
  const re = new RegExp(`new\\s+(${aliasUnion})\\.([A-Z][A-Za-z0-9]*)\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const module = aliasToModule.get(m[1]);
    if (!module) continue;
    const key = `${module}.${m[2]}`;
    const types = CDK_L2_TO_L1[key];
    if (!types) continue;
    for (const t of types) {
      // L1 hits already win (they're more specific); L2 only fills gaps.
      if (!out.has(t)) out.set(t, 'l2');
    }
  }
  return out;
}

/**
 * Detect `AWS::Service::Type` references anywhere in the file. Both
 * quoted forms (`'AWS::S3::Bucket'` for `CfnResource` / property
 * overrides) and bare forms (`// covers: AWS::S3::Bucket` documentation
 * comments) are accepted — in either case the contributor is asserting
 * the fixture exercises that type. A bare-comment claim that turns out
 * to be wrong is a documentation lie, not a hidden orphan; the matrix
 * doesn't try to verify the claim, just record it.
 */
export function scanLiteralTypes(content: string): Map<string, 'literal'> {
  const out = new Map<string, 'literal'>();
  const re = /\bAWS::([A-Za-z0-9]+)::([A-Za-z0-9]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.set(`AWS::${m[1]}::${m[2]}`, 'literal');
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReport(): CoverageReport {
  const registerSrc = readFileSync(REGISTER_FILE, 'utf8');
  const registeredTypes = parseRegisteredTypes(registerSrc);
  const registeredSet = new Set(registeredTypes);
  const allowList = parseAllowNoIntegRationales();

  // Map: resourceType -> { integ -> Set<signal> }
  const matrix = new Map<string, Map<string, Set<'l1' | 'l2' | 'literal'>>>();
  for (const t of registeredTypes) matrix.set(t, new Map());
  // Resource types referenced by integs that are NOT in the registered
  // set (often L1 types with no SDK provider, like AWS::CDK::Metadata).
  // Surfaced separately in the report so contributors can decide
  // whether to register them.
  const unknownTypes = new Set<string>();

  for (const fixture of listFixtures()) {
    const fixtureDir = join(INTEG_DIR, fixture);
    const files = listLibAndBinFiles(fixtureDir);
    if (files.length === 0) continue;
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const aliases = parseImportAliases(content);
      const seen = new Map<string, Set<'l1' | 'l2' | 'literal'>>();
      const recordHits = (
        hits: Map<string, 'l1' | 'l2' | 'literal'>
      ): void => {
        for (const [type, kind] of hits) {
          if (!seen.has(type)) seen.set(type, new Set());
          seen.get(type)!.add(kind);
        }
      };
      recordHits(scanL1Types(content, aliases));
      recordHits(scanL2Types(content, aliases));
      recordHits(scanLiteralTypes(content));

      for (const [type, kinds] of seen) {
        if (!registeredSet.has(type)) {
          unknownTypes.add(type);
          continue;
        }
        const perFixture = matrix.get(type)!;
        if (!perFixture.has(fixture)) perFixture.set(fixture, new Set());
        for (const k of kinds) perFixture.get(fixture)!.add(k);
      }
    }
  }

  const covered: CoverageEntry[] = [];
  const orphans: string[] = [];
  const allowListed: AllowListEntry[] = [];
  for (const type of registeredTypes) {
    const perFixture = matrix.get(type)!;
    if (perFixture.size === 0) {
      // Allow-list takes precedence over orphan classification — the
      // type was deliberately registered without an integ and the
      // contributor wrote down why.
      const rationale = allowList.get(type);
      if (rationale !== undefined) {
        allowListed.push({ resourceType: type, rationale });
      } else {
        orphans.push(type);
      }
      continue;
    }
    const integs = Array.from(perFixture.keys()).sort();
    const signals: Record<string, ('literal' | 'l1' | 'l2')[]> = {};
    for (const integ of integs) {
      signals[integ] = Array.from(perFixture.get(integ)!).sort();
    }
    covered.push({ resourceType: type, integs, signals });
  }

  return {
    registeredTypes,
    covered,
    orphans,
    allowListed,
    unknownTypesInIntegs: Array.from(unknownTypes).sort(),
  };
}

function renderMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push('# Integration Test Coverage Matrix');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by scripts/build-integ-coverage-matrix.ts. Do not hand-edit. -->'
  );
  lines.push('');
  lines.push('Run `vp run integ-coverage` to regenerate.');
  lines.push('');
  lines.push(
    `**${report.covered.length} / ${report.registeredTypes.length} registered SDK Providers** have at least one integ fixture exercising them. ${report.allowListed.length} are explicitly allow-listed (registered without an integ, with a rationale comment on the register line). ${report.orphans.length} are orphans — registered with neither an integ nor an allow-list rationale.`
  );
  lines.push('');
  lines.push('## How this is computed');
  lines.push('');
  lines.push(
    'For each fixture under `tests/integration/<name>/`, the script scans `lib/*.ts` and `bin/*.ts` for three signals against the resource types registered in [src/provisioning/register-providers.ts](../src/provisioning/register-providers.ts):'
  );
  lines.push('');
  lines.push(
    '- **literal** — a `\'AWS::Service::Type\'` string anywhere in the file (covers `CfnResource` usage and `addPropertyOverride` shapes).'
  );
  lines.push(
    '- **l1** — a `new <ns>.Cfn<TypeName>(` call resolved via the `aws-cdk-lib/aws-<module>` import alias.'
  );
  lines.push(
    '- **l2** — a `new <ns>.<Construct>(` call against the curated L2 -> L1 lookup table inside the script.'
  );
  lines.push('');
  lines.push(
    'L2 detection is a hand-curated lower bound — a missed L2 wrapper produces a false-negative ("type appears uncovered"). When you add a fixture that uses an L2 the matrix does not see, extend `CDK_L2_TO_L1` in [scripts/build-integ-coverage-matrix.ts](../scripts/build-integ-coverage-matrix.ts).'
  );
  lines.push('');
  if (report.orphans.length > 0) {
    lines.push(`## Orphan providers (${report.orphans.length})`);
    lines.push('');
    lines.push(
      'These SDK Providers are registered but have NO integ fixture exercising them and NO `// allow-no-integ:` rationale. Each is a real-AWS verification gap — a refactor that breaks one will not surface in any existing integ run. Either back the type with a fixture (literal type id, `Cfn<Type>(` L1, or extend the L2 lookup table) or add a rationale comment on the register line.'
    );
    lines.push('');
    lines.push('| Resource Type |');
    lines.push('|---|');
    for (const t of report.orphans) {
      lines.push(`| \`${t}\` |`);
    }
    lines.push('');
  } else {
    lines.push('## Orphan providers');
    lines.push('');
    lines.push(
      '_None._ Every registered SDK Provider has at least one integ fixture or an explicit `// allow-no-integ:` rationale.'
    );
    lines.push('');
  }

  if (report.allowListed.length > 0) {
    lines.push(`## Allow-listed providers (${report.allowListed.length})`);
    lines.push('');
    lines.push(
      'Registered without an integ fixture, with an explicit `// allow-no-integ: <rationale>` comment on the register line in [src/provisioning/register-providers.ts](../src/provisioning/register-providers.ts). The hook accepts these — but each is a deliberate verification gap and should be revisited if a real-AWS bug surfaces against the type.'
    );
    lines.push('');
    lines.push('| Resource Type | Rationale |');
    lines.push('|---|---|');
    for (const e of report.allowListed) {
      lines.push(`| \`${e.resourceType}\` | ${e.rationale} |`);
    }
    lines.push('');
  }

  lines.push(`## Covered providers (${report.covered.length})`);
  lines.push('');
  lines.push('| Resource Type | Integ Fixture(s) |');
  lines.push('|---|---|');
  for (const entry of report.covered) {
    const fixtures = entry.integs
      .map((f) => {
        const sig = entry.signals[f].join(',');
        return `[\`${f}\`](../tests/integration/${f}/) (${sig})`;
      })
      .join('<br>');
    lines.push(`| \`${entry.resourceType}\` | ${fixtures} |`);
  }
  lines.push('');

  if (report.unknownTypesInIntegs.length > 0) {
    lines.push(
      `## Resource types referenced in integs without an SDK Provider (${report.unknownTypesInIntegs.length})`
    );
    lines.push('');
    lines.push(
      'These resource types appear in integ fixtures but no SDK Provider is registered for them — they fall through to the Cloud Control API fallback. Listed here for visibility; not actionable on its own.'
    );
    lines.push('');
    for (const t of report.unknownTypesInIntegs) {
      lines.push(`- \`${t}\``);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * True when the file is executed directly (`node scripts/build-...ts`),
 * false when imported by a test or another script. Mirrors the pattern
 * in `scripts/audit-provider-coverage.ts` so importing the module
 * surface for unit tests does NOT trigger the matrix regeneration.
 */
const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === __filename;
};

function main(): void {
  const report = buildReport();
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(OUTPUT_MD, renderMarkdown(report), 'utf8');
  const covered = report.covered.length;
  const total = report.registeredTypes.length;
  const orphans = report.orphans.length;
  const allow = report.allowListed.length;
  process.stderr.write(
    `integ-coverage: wrote ${basename(OUTPUT_MD)} and ${basename(OUTPUT_JSON)} — ${covered}/${total} covered, ${allow} allow-listed, ${orphans} orphan(s)\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    // Surface a one-line context message so a missing / unreadable
    // register-providers.ts or a broken sidecar JSON produces an
    // actionable error rather than a raw stack trace. Internal tool;
    // exit 1 is appropriate.
    process.stderr.write(
      `integ-coverage: failed — ${(err as Error).message}\n`
    );
    process.exit(1);
  }
}
