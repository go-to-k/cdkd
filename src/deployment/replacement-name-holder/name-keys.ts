/**
 * How a type's colliding name is read from a property bag, for
 * {@link reverseReplacementNewHoldsName}. `name` lists alternative paths (the
 * first that yields a name wins); `scope` lists the properties that place the
 * name — two resources of one name in different scopes are two resources, so
 * a scope that differs means the new resource cannot hold the old one's name.
 * An absent scope property reads as `scopeDefaults[i]` when one is given.
 */
export interface NameKey {
  readonly name: ReadonlyArray<readonly string[]>;
  readonly scope?: ReadonlyArray<readonly string[]>;
  readonly scopeDefaults?: ReadonlyArray<string | undefined>;
}

export const flat = (property: string): NameKey => ({ name: [[property]] });

/**
 * A per-type table's OWN entry: a resource type is template text, and an
 * inherited key (`constructor`, `__proto__`, `toString`) must read as absent,
 * never as an entry.
 */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * The name key of every type whose name is NOT read by the generic
 * {@link explicitNamePropertyFor} rule — a nested name, a name placed by a
 * parent (scope), or a type absent from that table — keyed by type.
 */
export const REVERSE_REPLACEMENT_NAME_KEYS: Readonly<Record<string, NameKey>> = {
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
 * parent only through the anchor residual in `retryable-errors/name-collision.ts`).
 */
export const NOT_NAME_KEYED_TYPES: ReadonlySet<string> = new Set([
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
export const CASE_INSENSITIVE_NAME_TYPES: ReadonlySet<string> = new Set([
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
 * Types whose SDK provider mints `applyDefaultNameForFallback`'s name VERBATIM
 * for a nameless create (same maxLength, pattern and case, no prefix or
 * suffix), audited provider by provider. Only for these does the `generated`
 * bag name what the create sent; every other type ignores it, so a wrap the
 * audit did not see (a log group's `/cdkd/<name>`, an SSM parameter's
 * `/<name>`, a directory bucket's `--<az>--x-s3`, an S3 bucket's pattern
 * keeping `.`) can only refuse, never
 * prove a holder. Adding a type is a deliberate edit of the pinned literal.
 * A type in {@link SENT_NAME_REWRITTEN} is never here: its provider derives
 * even an EXPLICIT name, so that table owns its whole name.
 */
export const GENERATED_NAME_VERBATIM: ReadonlySet<string> = new Set([
  'AWS::CloudWatch::Alarm',
  'AWS::DocDB::DBCluster',
  'AWS::DocDB::DBInstance',
  'AWS::DocDB::DBSubnetGroup',
  'AWS::DynamoDB::Table',
  'AWS::ECR::Repository',
  'AWS::ECS::Cluster',
  'AWS::ECS::Service',
  'AWS::ElastiCache::CacheCluster',
  'AWS::ElastiCache::SubnetGroup',
  'AWS::Events::Rule',
  'AWS::Kinesis::Stream',
  'AWS::Lambda::Function',
  'AWS::Neptune::DBCluster',
  'AWS::Neptune::DBInstance',
  'AWS::Neptune::DBSubnetGroup',
  'AWS::RDS::DBCluster',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBSubnetGroup',
  'AWS::SecretsManager::Secret',
  'AWS::SNS::Topic',
  'AWS::SQS::Queue',
  'AWS::StepFunctions::StateMachine',
  'AWS::WAFv2::WebACL',
]);

/**
 * Types whose SDK provider sends `generateResourceNameWithFallback(<property>,
 * logicalId, { maxLength })` — for an explicit name too — so the name AWS is
 * asked for is NOT the recorded one: it depends on the stack-name scope
 * (`withStackName`) and the prefix flag (`withSkipPrefix`) — the failed
 * deploy's flag, which `cdkd rollback` restores from the journal segment
 * (go-to-k/cdkd#4018), unless {@link replayPrefixChoice} finds that the OTHER
 * flag created the old resource (go-to-k/cdkd#4024) — and the default pattern
 * rewrites `_` and `.` to `-`. So a recorded name proves nothing here: the
 * name the re-create sends is derived IN THE CURRENT SCOPE by the provider's
 * own generator, and only the new resource's physical id naming THAT name
 * proves a holder. Fenced against the generator's callers in
 * `src/provisioning/providers/`.
 */
export const SENT_NAME_REWRITTEN: Readonly<
  Record<string, { readonly property: string; readonly maxLength: number }>
> = {
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { property: 'Name', maxLength: 32 },
  'AWS::ElasticLoadBalancingV2::TargetGroup': { property: 'Name', maxLength: 32 },
  'AWS::IAM::Group': { property: 'GroupName', maxLength: 128 },
  'AWS::IAM::InstanceProfile': { property: 'InstanceProfileName', maxLength: 128 },
  'AWS::IAM::ManagedPolicy': { property: 'ManagedPolicyName', maxLength: 128 },
  'AWS::IAM::Role': { property: 'RoleName', maxLength: 64 },
  'AWS::IAM::User': { property: 'UserName', maxLength: 64 },
};
