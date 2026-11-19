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
 * cannot disagree. A `none` verdict names the evidence on BOTH routes: the
 * parent's SDK provider read, and (after `Cloud Control:`) its registry
 * schema, since a Cloud Control read returns every property the model holds.
 * A pair whose parent schema carries the child's members collides there and
 * needs a row, not a `none` entry.
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
        'the group read has no member list; Cloud Control: the Group schema has no member list',
      ],
      [
        'AWS::Lambda::Permission',
        'AWS::Lambda::Function',
        'policy',
        'lambda-function read-state emits no Policy; Cloud Control: the Function schema has no Policy',
      ],
      [
        'AWS::Lambda::EventSourceMapping / EventInvokeConfig / Url',
        'AWS::Lambda::Function',
        '-',
        'lambda-function read-state emits none of their keys; Cloud Control: the Function schema has none of their keys',
      ],
      [
        'AWS::S3::BucketPolicy',
        'AWS::S3::Bucket',
        'policy',
        's3-bucket read-state emits no Policy; Cloud Control: the Bucket schema has no Policy',
      ],
      [
        'AWS::SNS::TopicPolicy',
        'AWS::SNS::Topic',
        'policy',
        'sns-topic read-state emits no Policy; Cloud Control: the Topic schema has no Policy',
      ],
      [
        'AWS::SQS::QueuePolicy',
        'AWS::SQS::Queue',
        'policy',
        'the SQS queue read emits no Policy; Cloud Control: the Queue schema has no Policy',
      ],
      [
        'AWS::SNS::TopicInlinePolicy',
        'AWS::SNS::Topic',
        'policy',
        'sns-topic read-state emits no Policy; Cloud Control: the Topic schema has no Policy',
      ],
      [
        'AWS::SQS::QueueInlinePolicy',
        'AWS::SQS::Queue',
        'policy',
        'the SQS queue read emits no Policy; Cloud Control: the Queue schema has no Policy',
      ],
      [
        'AWS::Logs::SubscriptionFilter',
        'AWS::Logs::LogGroup',
        'filters',
        'logs-loggroup read-state emits no filter key; Cloud Control: the LogGroup schema has no filter property',
      ],
      [
        'AWS::ElasticLoadBalancingV2::ListenerRule',
        'AWS::ElasticLoadBalancingV2::Listener',
        'rules',
        "the listener read has no rule list; DefaultActions is the listener's own; Cloud Control: the Listener schema has no rule list",
      ],
      [
        'AWS::ElasticLoadBalancingV2::ListenerCertificate',
        'AWS::ElasticLoadBalancingV2::Listener',
        'Certificates',
        'DescribeListeners returns the default certificate only; Cloud Control: the Listener model is read from DescribeListeners too',
      ],
      [
        'AWS::EC2::NetworkAclEntry',
        'AWS::EC2::NetworkAcl',
        'entries',
        'the network ACL read emits VpcId only; Cloud Control: the NetworkAcl schema holds Id, Tags and VpcId only',
      ],
      [
        'AWS::EC2::Route',
        'AWS::EC2::RouteTable',
        'routes',
        'the route table read emits VpcId only; Cloud Control: the RouteTable schema holds RouteTableId, Tags and VpcId only',
      ],
      [
        'AWS::EC2::SubnetRouteTableAssociation / SubnetNetworkAclAssociation',
        'AWS::EC2::Subnet / RouteTable / NetworkAcl',
        'associations',
        "none of the three reads emits an association; Cloud Control: the Subnet's NetworkAclAssociationId is read-only (#6485); the other two schemas have no association",
      ],
      [
        'AWS::EC2::VPCGatewayAttachment',
        'AWS::EC2::VPC / InternetGateway',
        'attachments',
        'neither read emits an attachment; Cloud Control: neither schema has an attachment property',
      ],
      [
        'AWS::EC2::VPCCidrBlock',
        'AWS::EC2::VPC',
        'CidrBlockAssociations',
        'the VPC read emits the primary CidrBlock only; Cloud Control: the list is read-only (#6485)',
      ],
      [
        'AWS::KMS::Alias',
        'AWS::KMS::Key',
        'aliases',
        'the key read emits no alias; Cloud Control: the Key schema has no alias',
      ],
      [
        'AWS::SecretsManager::ResourcePolicy / RotationSchedule',
        'AWS::SecretsManager::Secret',
        '-',
        'the secret read emits neither; Cloud Control: the Secret schema has neither',
      ],
      [
        'AWS::Cognito::UserPoolClient / UserPoolDomain',
        'AWS::Cognito::UserPool',
        '-',
        'the user pool read emits neither; Cloud Control: the UserPool schema has neither',
      ],
      [
        'AWS::Route53::RecordSet',
        'AWS::Route53::HostedZone',
        'records',
        'the hosted zone read emits no records; Cloud Control: the HostedZone schema has no record list',
      ],
      [
        'AWS::ApiGateway::Method / Resource',
        'AWS::ApiGateway::Resource / RestApi',
        '-',
        'the resource read emits ParentId and PathPart only; Cloud Control: neither schema lists methods or child resources',
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
