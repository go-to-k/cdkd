/**
 * go-to-k/cdkd#6610: the audit's verdict for every child -> parent property
 * pair, the documentation half of `../sibling-owned-members.ts`.
 */
import { SIBLING_OWNED_ROWS } from './rows.js';

/** A recorded verdict for one (child, parent, key) pair; see the module comment. */
export interface SiblingWritePair {
  child: string;
  parent: string;
  key: string;
  verdict: 'table' | 'helper' | 'none';
  /** Where it is handled, or which read shows it does not collide. */
  evidence: string;
}

/**
 * Every child -> parent property pair the go-to-k/cdkd#6610 audit examined.
 * The `table` entries are derived from {@link SIBLING_OWNED_ROWS}, so the two
 * cannot disagree. A `none` verdict's evidence is the parent's SDK provider
 * read, the route every listed parent takes unless its record is pinned to
 * Cloud Control; a Cloud Control read returns every schema property the model
 * holds, so a pair whose parent schema carries the child's members collides
 * there and needs a row, not a `none` entry.
 */
export const SIBLING_WRITE_PAIRS: readonly SiblingWritePair[] = [
  ...SIBLING_OWNED_ROWS.map((row): SiblingWritePair => ({
    child: row.child,
    parent: row.parent,
    key: row.key,
    verdict: 'table',
    evidence: 'SIBLING_OWNED_ROWS',
  })),
  ...(['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Group'] as const).map(
    (parent): SiblingWritePair => ({
      child: 'AWS::IAM::ManagedPolicy',
      parent,
      key: 'ManagedPolicyArns',
      verdict: 'helper',
      evidence: 'iam-sibling-managed-policies.ts (#6324)',
    })
  ),
  ...(['Roles', 'Users', 'Groups'] as const).map((key): SiblingWritePair => ({
    child: 'AWS::IAM::Role / User / Group',
    parent: 'AWS::IAM::ManagedPolicy',
    key,
    verdict: 'helper',
    evidence: 'iam-sibling-managed-policies.ts (#6328)',
  })),
  {
    child: 'AWS::IAM::UserToGroupAddition',
    parent: 'AWS::IAM::User',
    key: 'Groups',
    verdict: 'helper',
    evidence: 'iam-sibling-managed-policies.ts (#6328)',
  },
  ...(['SecurityGroupIngress', 'SecurityGroupEgress'] as const).map((key): SiblingWritePair => ({
    child: `AWS::EC2::${key}`,
    parent: 'AWS::EC2::SecurityGroup',
    key,
    verdict: 'helper',
    evidence: 'sg-sibling-rules.ts (#6418)',
  })),
  {
    child: 'Custom::S3BucketNotifications',
    parent: 'AWS::S3::Bucket',
    key: 'NotificationConfiguration',
    verdict: 'helper',
    evidence: 'undeclaredUncomparedDriftKeys (#5736): any writer, any stack',
  },
  {
    child: 'AWS::Events::EventBusPolicy',
    parent: 'AWS::Events::EventBus',
    key: 'Policy',
    verdict: 'helper',
    evidence: 'undeclaredUncomparedDriftKeys (#6323): any writer, any stack',
  },
  {
    child: 'AWS::EC2::VolumeAttachment',
    parent: 'AWS::EC2::Instance',
    key: 'BlockDeviceMappings',
    verdict: 'helper',
    evidence: 'undeclaredUncomparedDriftKeys + declared-devices readback (#6384)',
  },
  ...(
    [
      [
        'AWS::IAM::UserToGroupAddition',
        'AWS::IAM::Group',
        'members',
        'the group read has no member list',
      ],
      [
        'AWS::Lambda::Permission',
        'AWS::Lambda::Function',
        'policy',
        'lambda-function read-state emits no Policy',
      ],
      [
        'AWS::Lambda::EventSourceMapping / EventInvokeConfig / Url',
        'AWS::Lambda::Function',
        '-',
        'lambda-function read-state emits none of their keys',
      ],
      [
        'AWS::S3::BucketPolicy',
        'AWS::S3::Bucket',
        'policy',
        's3-bucket read-state emits no Policy',
      ],
      [
        'AWS::SNS::TopicPolicy',
        'AWS::SNS::Topic',
        'policy',
        'sns-topic read-state emits no Policy',
      ],
      ['AWS::SQS::QueuePolicy', 'AWS::SQS::Queue', 'policy', 'the SQS queue read emits no Policy'],
      [
        'AWS::SNS::TopicInlinePolicy',
        'AWS::SNS::Topic',
        'policy',
        'sns-topic read-state emits no Policy',
      ],
      [
        'AWS::SQS::QueueInlinePolicy',
        'AWS::SQS::Queue',
        'policy',
        'the SQS queue read emits no Policy',
      ],
      [
        'AWS::Logs::SubscriptionFilter',
        'AWS::Logs::LogGroup',
        'filters',
        'logs-loggroup read-state emits no filter key',
      ],
      [
        'AWS::ElasticLoadBalancingV2::ListenerRule',
        'AWS::ElasticLoadBalancingV2::Listener',
        'rules',
        "the listener read has no rule list; DefaultActions is the listener's own",
      ],
      [
        'AWS::ElasticLoadBalancingV2::ListenerCertificate',
        'AWS::ElasticLoadBalancingV2::Listener',
        'Certificates',
        'DescribeListeners returns the default certificate only',
      ],
      [
        'AWS::EC2::NetworkAclEntry',
        'AWS::EC2::NetworkAcl',
        'entries',
        'the network ACL read emits VpcId only',
      ],
      [
        'AWS::EC2::Route',
        'AWS::EC2::RouteTable',
        'routes',
        'the route table read emits VpcId only',
      ],
      [
        'AWS::EC2::SubnetRouteTableAssociation / SubnetNetworkAclAssociation',
        'AWS::EC2::Subnet / RouteTable / NetworkAcl',
        'associations',
        'none of the three reads emits an association',
      ],
      [
        'AWS::EC2::VPCGatewayAttachment',
        'AWS::EC2::VPC / InternetGateway',
        'attachments',
        'neither read emits an attachment',
      ],
      [
        'AWS::EC2::VPCCidrBlock',
        'AWS::EC2::VPC',
        'CidrBlockAssociations',
        'the VPC read emits the primary CidrBlock only; on Cloud Control the list is read-only (#6485)',
      ],
      [
        'AWS::EC2::NetworkInterfaceAttachment',
        'AWS::EC2::Instance',
        'NetworkInterfaces',
        'the instance read emits no NetworkInterfaces',
      ],
      ['AWS::KMS::Alias', 'AWS::KMS::Key', 'aliases', 'the key read emits no alias'],
      [
        'AWS::SecretsManager::ResourcePolicy / RotationSchedule',
        'AWS::SecretsManager::Secret',
        '-',
        'the secret read emits neither',
      ],
      [
        'AWS::Cognito::UserPoolClient / UserPoolDomain',
        'AWS::Cognito::UserPool',
        '-',
        'the user pool read emits neither',
      ],
      [
        'AWS::Route53::RecordSet',
        'AWS::Route53::HostedZone',
        'records',
        'the hosted zone read emits no records',
      ],
      [
        'AWS::ApiGateway::Method / Resource',
        'AWS::ApiGateway::Resource / RestApi',
        '-',
        'the resource read emits ParentId and PathPart only',
      ],
    ] as const
  ).map(([child, parent, key, evidence]): SiblingWritePair => ({
    child,
    parent,
    key,
    verdict: 'none',
    evidence,
  })),
];
