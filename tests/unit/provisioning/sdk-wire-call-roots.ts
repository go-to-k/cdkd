/**
 * Which call a request is, when a provider sends one command for more than one
 * CFn subtree (go-to-k/cdkd#3723).
 *
 * The wrong-member trace in `sdk-wire-harness.ts` roots each landing chain at
 * its command. A command sent twice in one run (a table's and its stream's
 * `PutResourcePolicyCommand`) would let a value sent in the OTHER call match,
 * so either a `roots` function names each call from its input (the chain's
 * root becomes `<command>:<name>`, which `sdk-wire-member-renames.ts`
 * containers spell), or `repeated` says why the calls need no telling apart.
 *
 * The harness finds every root a traced probe saw sent more than once: a
 * `<command>` with no `roots` function, or a `<command>:<name>` a function
 * gave two calls alike (two GSIs, both `:index`). The per-type `declares
 * roots or a reason for every repeated command` case requires that set to
 * EQUAL `repeated`'s keys: a new repeat fails until it is rooted or reasoned,
 * and a reason no probe needs is stale.
 */

/** Names which of several same-command calls a request is, from its input. */
export type CommandRoot = (input: Record<string, unknown>) => string;

export interface CallRoots {
  roots?: Record<string, CommandRoot>;
  /** Root (`<command>` or `<command>:<name>`) -> why its repeated calls need no telling apart. */
  repeated?: Record<string, string>;
}

const tableOrStream: CommandRoot = (input) =>
  String(input['ResourceArn']).includes('/stream/') ? 'stream' : 'table';

const tableOrIndex: CommandRoot = (input) =>
  input['IndexName'] === undefined ? 'table' : 'index';

/** Application Auto Scaling: `<resource kind>-<dimension kind>-<read|write>`. */
const scalingTarget: CommandRoot = (input) => {
  const resource = String(input['ResourceId']).includes('/index/') ? 'index' : 'table';
  const [, kind = '', units = ''] = String(input['ScalableDimension']).split(':');
  return `${resource}-${kind}-${units.startsWith('Write') ? 'write' : 'read'}`;
};

const PER_ITEM = (list: string, key: string): string =>
  `one call per ${list} item, each naming its own ${key}: the items are told apart inside the input, not by the root, so a value sent with another item is a bound of the trace`;

const PER_PRINCIPAL = (what: string): string =>
  `one call per principal the ${what} lists, each sending the same document: nothing differs between the calls for a value to land in the wrong one`;

export const CALL_ROOTS: Record<string, CallRoots> = {
  'AWS::ApiGateway::Method': {
    repeated: {
      PutMethodResponseCommand: PER_ITEM('MethodResponses', 'statusCode'),
      PutIntegrationResponseCommand: PER_ITEM('Integration.IntegrationResponses', 'statusCode'),
    },
  },
  'AWS::AutoScaling::AutoScalingGroup': {
    repeated: {
      PutNotificationConfigurationCommand: PER_ITEM('NotificationConfigurations', 'TopicARN'),
    },
  },
  'AWS::DynamoDB::Table': {
    roots: {
      PutResourcePolicyCommand: tableOrStream,
      TagResourceCommand: tableOrStream,
      UpdateContributorInsightsCommand: tableOrIndex,
    },
  },
  'AWS::DynamoDB::GlobalTable': {
    roots: {
      PutResourcePolicyCommand: tableOrStream,
      RegisterScalableTargetCommand: scalingTarget,
      PutScalingPolicyCommand: scalingTarget,
      UpdateContributorInsightsCommand: tableOrIndex,
    },
    repeated: {
      UpdateTableCommand:
        'one call per update step (an index create, a replica update, a settings change), each carrying its own update member, which the chain names',
    },
  },
  'AWS::EC2::NatGateway': {
    repeated: {
      AssociateNatGatewayAddressCommand: PER_ITEM('AvailabilityZoneAddresses', 'address'),
    },
  },
  'AWS::EC2::VPC': {
    repeated: {
      ModifyVpcAttributeCommand:
        'one call per attribute (EnableDnsSupport, EnableDnsHostnames), each sending only its own member, which the chain names',
    },
  },
  'AWS::IAM::Group': {
    repeated: {
      AttachGroupPolicyCommand: PER_ITEM('ManagedPolicyArns', 'PolicyArn'),
      PutGroupPolicyCommand: PER_ITEM('Policies', 'PolicyName'),
    },
  },
  'AWS::IAM::ManagedPolicy': {
    repeated: {
      AttachGroupPolicyCommand: PER_PRINCIPAL('Groups list'),
      AttachRolePolicyCommand: PER_PRINCIPAL('Roles list'),
      AttachUserPolicyCommand: PER_PRINCIPAL('Users list'),
    },
  },
  'AWS::IAM::Policy': {
    repeated: {
      PutGroupPolicyCommand: PER_PRINCIPAL('Groups list'),
      PutRolePolicyCommand: PER_PRINCIPAL('Roles list'),
      PutUserPolicyCommand: PER_PRINCIPAL('Users list'),
      DeleteGroupPolicyCommand: PER_PRINCIPAL('Groups list'),
      DeleteRolePolicyCommand: PER_PRINCIPAL('Roles list'),
      DeleteUserPolicyCommand: PER_PRINCIPAL('Users list'),
    },
  },
  'AWS::IAM::Role': {
    repeated: {
      AttachRolePolicyCommand: PER_ITEM('ManagedPolicyArns', 'PolicyArn'),
      PutRolePolicyCommand: PER_ITEM('Policies', 'PolicyName'),
    },
  },
  'AWS::IAM::User': {
    repeated: {
      AddUserToGroupCommand: PER_ITEM('Groups', 'GroupName'),
      AttachUserPolicyCommand: PER_ITEM('ManagedPolicyArns', 'PolicyArn'),
      PutUserPolicyCommand: PER_ITEM('Policies', 'PolicyName'),
    },
  },
  'AWS::IAM::UserToGroupAddition': {
    repeated: {
      AddUserToGroupCommand: PER_ITEM('Users', 'UserName'),
    },
  },
  'AWS::S3::Bucket': {
    repeated: {
      PutBucketAnalyticsConfigurationCommand: PER_ITEM('AnalyticsConfigurations', 'Id'),
      PutBucketIntelligentTieringConfigurationCommand: PER_ITEM(
        'IntelligentTieringConfigurations',
        'Id'
      ),
      PutBucketInventoryConfigurationCommand: PER_ITEM('InventoryConfigurations', 'Id'),
      PutBucketMetricsConfigurationCommand: PER_ITEM('MetricsConfigurations', 'Id'),
    },
  },
  'AWS::S3Express::DirectoryBucket': {
    repeated: {
      PutBucketInventoryConfigurationCommand: PER_ITEM('InventoryConfigurations', 'Id'),
      PutBucketMetricsConfigurationCommand: PER_ITEM('MetricsConfigurations', 'Id'),
    },
  },
  'AWS::SNS::Topic': {
    repeated: {
      SetTopicAttributesCommand:
        'one call per attribute, each naming it in AttributeName, which the keyed-entry match requires the value to land under',
      SubscribeCommand: PER_ITEM('Subscription', 'Endpoint'),
    },
  },
  'AWS::SNS::TopicPolicy': {
    repeated: {
      SetTopicAttributesCommand: PER_PRINCIPAL('Topics list'),
    },
  },
  'AWS::SQS::QueuePolicy': {
    repeated: {
      SetQueueAttributesCommand: PER_PRINCIPAL('Queues list'),
    },
  },
};
