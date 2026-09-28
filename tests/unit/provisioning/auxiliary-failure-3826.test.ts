import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #3826: a provider `create()` whose AUXILIARY call (a rule, a tag, an
 * attribute, an alias, a subscription...) fails with AWS's "already exists"
 * must not be classified as the resource's own name collision, while the MAIN
 * create's collision still is.
 *
 * Driven through the real providers and the real classifier. Each SDK client
 * class's `send` is stubbed on its PROTOTYPE, so every provider reaches its own
 * real client and the stub answers by COMMAND name: the main create resolves
 * with a canned response (or rejects, in the main-collision case), the named
 * auxiliary command rejects with an AWS-shaped "already exists", and anything
 * else resolves with its canned response or `{}`.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

import { APIGatewayClient } from '@aws-sdk/client-api-gateway';
import { AppSyncClient } from '@aws-sdk/client-appsync';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CodeCommitClient } from '@aws-sdk/client-codecommit';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECRClient } from '@aws-sdk/client-ecr';
import { EFSClient } from '@aws-sdk/client-efs';
import { IAMClient } from '@aws-sdk/client-iam';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { KMSClient } from '@aws-sdk/client-kms';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { ServiceDiscoveryClient } from '@aws-sdk/client-servicediscovery';
import { SNSClient } from '@aws-sdk/client-sns';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';

import {
  isNameCollisionError,
  isNameCollisionErrorFrom,
} from '../../../src/deployment/retryable-errors.js';
import { maskSecretsInError } from '../../../src/deployment/secret-redaction.js';
import {
  auxiliaryLogicalId,
  markAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { CodeCommitRepositoryProvider } from '../../../src/provisioning/providers/codecommit-repository-provider.js';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';
import { EFSProvider } from '../../../src/provisioning/providers/efs-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { RDSDBProxyTargetGroupProvider } from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import { codeLines } from '../_code-lines.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

/** An SDK client class; its `send` lives on the shared Smithy base prototype. */
type ClientClass = { prototype: object };
type Sendable = { send: (command: unknown) => Promise<unknown> };

interface Case {
  /**
   * Label: `<provider file stem> <type>`. The stem is load-bearing: the
   * population fence below maps each case to `<stem>-provider.ts`.
   */
  name: string;
  provider: () => ResourceProvider;
  resourceType: string;
  properties: Record<string, unknown>;
  /** Every SDK client class the create path sends through. */
  clients: ClientClass[];
  /** The command that creates the resource itself; absent when there is none. */
  main?: string;
  /** An auxiliary command the create path sends after (or before) `main`. */
  aux: string;
  /** Canned responses by command name. */
  responses?: Record<string, unknown>;
  /** The AWS error the AUXILIARY command raises, when a real spelling is known. */
  auxAwsError?: { name: string; message: string };
  /**
   * The AWS error the MAIN command raises on a name collision, where the
   * service has its own spelling, so the main half exercises the classifier's
   * NAME arm (ELBv2) or the service's real prose rather than a generic stand-in.
   */
  mainAwsError?: { name: string; message: string };
  /** Extra environment for the create (e.g. `CDKD_NO_WAIT` to skip a waiter). */
  env?: Record<string, string>;
  /**
   * Why the main-collision half is not run, when it cannot be: the provider
   * ADOPTS an existing object rather than failing on it.
   */
  mainCollisionNotRaised?: string;
  /** The auxiliary call runs BEFORE the main create rather than after it. */
  auxRunsFirst?: boolean;
}

const LOGICAL_ID = 'Subject';
const COLLISION_TEXT = 'The object with that name already exists';

const CASES: Case[] = [
  {
    name: 'lambda-function AWS::Lambda::Function',
    provider: () => new LambdaFunctionProvider(),
    resourceType: 'AWS::Lambda::Function',
    properties: {
      FunctionName: 'fn',
      Role: 'arn:aws:iam::123456789012:role/r',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: 'exports.handler = async () => {};' },
      ReservedConcurrentExecutions: 5,
    },
    clients: [LambdaClient],
    main: 'CreateFunctionCommand',
    mainAwsError: { name: 'ResourceConflictException', message: 'Function already exist: fn' },
    aux: 'PutFunctionConcurrencyCommand',
    responses: {
      CreateFunctionCommand: {
        FunctionName: 'fn',
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:fn',
      },
    },
  },
  {
    name: 'apigateway AWS::ApiGateway::Stage',
    provider: () => new ApiGatewayProvider(),
    resourceType: 'AWS::ApiGateway::Stage',
    properties: {
      RestApiId: 'api1',
      StageName: 'prod',
      DeploymentId: 'dep1',
      ClientCertificateId: 'cert1',
    },
    clients: [APIGatewayClient],
    main: 'CreateStageCommand',
    mainAwsError: { name: 'ConflictException', message: 'Stage already exists' },
    aux: 'UpdateStageCommand',
    responses: { CreateStageCommand: { stageName: 'prod' } },
  },
  {
    name: 'apigateway AWS::ApiGateway::Method',
    provider: () => new ApiGatewayProvider(),
    resourceType: 'AWS::ApiGateway::Method',
    properties: {
      RestApiId: 'api1',
      ResourceId: 'res1',
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
      Integration: { Type: 'MOCK' },
    },
    clients: [APIGatewayClient],
    main: 'PutMethodCommand',
    mainAwsError: { name: 'ConflictException', message: 'Method already exists for this resource' },
    aux: 'PutIntegrationCommand',
  },
  {
    name: 'appsync AWS::AppSync::GraphQLApi',
    provider: () => new AppSyncProvider(),
    resourceType: 'AWS::AppSync::GraphQLApi',
    properties: {
      Name: 'api',
      AuthenticationType: 'API_KEY',
      EnvironmentVariables: { K: 'v' },
    },
    clients: [AppSyncClient],
    main: 'CreateGraphqlApiCommand',
    aux: 'PutGraphqlApiEnvironmentVariablesCommand',
    responses: {
      CreateGraphqlApiCommand: {
        graphqlApi: { apiId: 'a1', arn: 'arn:aws:appsync:us-east-1:123456789012:apis/a1', uris: {} },
      },
    },
  },
  {
    name: 'cloudtrail AWS::CloudTrail::Trail',
    provider: () => new CloudTrailProvider(),
    resourceType: 'AWS::CloudTrail::Trail',
    properties: { TrailName: 'trail', S3BucketName: 'bucket' },
    clients: [CloudTrailClient],
    main: 'CreateTrailCommand',
    mainAwsError: { name: 'TrailAlreadyExistsException', message: 'Trail trail already exists for customer: 123456789012' },
    aux: 'StartLoggingCommand',
    responses: { CreateTrailCommand: { TrailARN: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/trail' } },
  },
  {
    name: 'codecommit-repository AWS::CodeCommit::Repository',
    provider: () => new CodeCommitRepositoryProvider(),
    resourceType: 'AWS::CodeCommit::Repository',
    properties: {
      RepositoryName: 'repo',
      Triggers: [
        { Name: 't', DestinationArn: 'arn:aws:sns:us-east-1:123456789012:t', Events: ['all'] },
      ],
    },
    clients: [CodeCommitClient],
    main: 'CreateRepositoryCommand',
    aux: 'PutRepositoryTriggersCommand',
    mainAwsError: { name: 'RepositoryNameExistsException', message: 'Repository named repo already exists' },
    responses: {
      CreateRepositoryCommand: {
        repositoryMetadata: {
          repositoryName: 'repo',
          repositoryId: 'id1',
          Arn: 'arn:aws:codecommit:us-east-1:123456789012:repo',
        },
      },
    },
  },
  {
    name: 'cognito AWS::Cognito::UserPool',
    provider: () => new CognitoUserPoolProvider(),
    resourceType: 'AWS::Cognito::UserPool',
    properties: { UserPoolName: 'pool', EnabledMfas: ['SOFTWARE_TOKEN_MFA'], MfaConfiguration: 'OPTIONAL' },
    clients: [CognitoIdentityProviderClient],
    main: 'CreateUserPoolCommand',
    aux: 'SetUserPoolMfaConfigCommand',
    responses: {
      CreateUserPoolCommand: {
        UserPool: { Id: 'us-east-1_abc', Arn: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc' },
      },
    },
  },
  {
    name: 'ec2 AWS::EC2::VPC',
    provider: () => new EC2Provider(),
    resourceType: 'AWS::EC2::VPC',
    properties: { CidrBlock: '10.0.0.0/16', EnableDnsHostnames: true },
    clients: [EC2Client],
    main: 'CreateVpcCommand',
    aux: 'ModifyVpcAttributeCommand',
    responses: { CreateVpcCommand: { Vpc: { VpcId: 'vpc-1' } } },
  },
  {
    name: 'ec2 AWS::EC2::Subnet',
    provider: () => new EC2Provider(),
    resourceType: 'AWS::EC2::Subnet',
    properties: { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24', MapPublicIpOnLaunch: true },
    clients: [EC2Client],
    main: 'CreateSubnetCommand',
    aux: 'ModifySubnetAttributeCommand',
    responses: { CreateSubnetCommand: { Subnet: { SubnetId: 'subnet-1' } } },
  },
  {
    name: 'ec2 AWS::EC2::EIP',
    provider: () => new EC2Provider(),
    resourceType: 'AWS::EC2::EIP',
    properties: { Domain: 'vpc', InstanceId: 'i-1' },
    clients: [EC2Client],
    main: 'AllocateAddressCommand',
    aux: 'AssociateAddressCommand',
    responses: { AllocateAddressCommand: { AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' } },
  },
  {
    // The canonical shape: an inline rule AWS reports as a duplicate
    // ("InvalidPermission.Duplicate: the specified rule ... already exists").
    name: 'ec2 AWS::EC2::SecurityGroup',
    provider: () => new EC2Provider(),
    resourceType: 'AWS::EC2::SecurityGroup',
    properties: {
      GroupName: 'sg',
      GroupDescription: 'd',
      VpcId: 'vpc-1',
      SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }],
    },
    clients: [EC2Client],
    main: 'CreateSecurityGroupCommand',
    mainAwsError: { name: 'InvalidGroup.Duplicate', message: "The security group 'sg' already exists for VPC 'vpc-1'" },
    aux: 'AuthorizeSecurityGroupIngressCommand',
    auxAwsError: {
      name: 'InvalidPermission.Duplicate',
      message:
        'the specified rule "peer: 0.0.0.0/0, TCP, from port: 443, to port: 443, ALLOW" already exists',
    },
    responses: {
      CreateSecurityGroupCommand: { GroupId: 'sg-1' },
      DescribeSecurityGroupsCommand: { SecurityGroups: [{ GroupId: 'sg-1', VpcId: 'vpc-1' }] },
    },
  },
  {
    name: 'ec2 AWS::EC2::Instance',
    provider: () => new EC2Provider(),
    resourceType: 'AWS::EC2::Instance',
    properties: { ImageId: 'ami-1', IamInstanceProfile: 'profile' },
    clients: [EC2Client],
    main: 'RunInstancesCommand',
    aux: 'AssociateIamInstanceProfileCommand',
    responses: {
      RunInstancesCommand: { Instances: [{ InstanceId: 'i-1' }] },
      DescribeInstancesCommand: {
        Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
      },
      DescribeIamInstanceProfileAssociationsCommand: { IamInstanceProfileAssociations: [] },
    },
  },
  {
    name: 'ecr AWS::ECR::Repository',
    provider: () => new ECRProvider(),
    resourceType: 'AWS::ECR::Repository',
    properties: { RepositoryName: 'repo', LifecyclePolicy: { LifecyclePolicyText: '{}' } },
    clients: [ECRClient],
    main: 'CreateRepositoryCommand',
    aux: 'PutLifecyclePolicyCommand',
    mainAwsError: { name: 'RepositoryAlreadyExistsException', message: "The repository with name 'repo' already exists in the registry with id '123456789012'" },
    responses: {
      CreateRepositoryCommand: {
        repository: { repositoryName: 'repo', repositoryArn: 'arn:aws:ecr:us-east-1:123456789012:repository/repo' },
      },
    },
  },
  {
    name: 'efs AWS::EFS::FileSystem',
    provider: () => new EFSProvider(),
    resourceType: 'AWS::EFS::FileSystem',
    properties: { BackupPolicy: { Status: 'ENABLED' } },
    clients: [EFSClient],
    main: 'CreateFileSystemCommand',
    aux: 'PutBackupPolicyCommand',
    responses: {
      CreateFileSystemCommand: { FileSystemId: 'fs-1', FileSystemArn: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-1' },
      DescribeFileSystemsCommand: { FileSystems: [{ FileSystemId: 'fs-1', LifeCycleState: 'available' }] },
    },
  },
  {
    name: 'elbv2 AWS::ElasticLoadBalancingV2::LoadBalancer',
    provider: () => new ELBv2Provider(),
    resourceType: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    properties: {
      Name: 'lb',
      Subnets: ['subnet-1', 'subnet-2'],
      LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '30' }],
    },
    clients: [ElasticLoadBalancingV2Client],
    main: 'CreateLoadBalancerCommand',
    mainAwsError: { name: 'DuplicateLoadBalancerNameException', message: "A load balancer with the same name 'lb' exists, but with different settings" },
    aux: 'ModifyLoadBalancerAttributesCommand',
    responses: {
      CreateLoadBalancerCommand: {
        LoadBalancers: [{ LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/lb/1' }],
      },
    },
    env: { CDKD_NO_WAIT: 'true' },
  },
  {
    name: 'elbv2 AWS::ElasticLoadBalancingV2::TargetGroup',
    provider: () => new ELBv2Provider(),
    resourceType: 'AWS::ElasticLoadBalancingV2::TargetGroup',
    properties: {
      Name: 'tg',
      Protocol: 'HTTP',
      Port: 80,
      VpcId: 'vpc-1',
      TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
    },
    clients: [ElasticLoadBalancingV2Client],
    main: 'CreateTargetGroupCommand',
    mainAwsError: { name: 'DuplicateTargetGroupNameException', message: "A target group with the same name 'tg' exists, but with different settings" },
    aux: 'ModifyTargetGroupAttributesCommand',
    responses: {
      CreateTargetGroupCommand: {
        TargetGroups: [{ TargetGroupArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/tg/1' }],
      },
    },
  },
  {
    name: 'elbv2 AWS::ElasticLoadBalancingV2::Listener',
    provider: () => new ELBv2Provider(),
    resourceType: 'AWS::ElasticLoadBalancingV2::Listener',
    properties: {
      LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/lb/1',
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200' } }],
      ListenerAttributes: [{ Key: 'routing.http.response.server.enabled', Value: 'false' }],
    },
    clients: [ElasticLoadBalancingV2Client],
    main: 'CreateListenerCommand',
    aux: 'ModifyListenerAttributesCommand',
    responses: {
      CreateListenerCommand: {
        Listeners: [{ ListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/lb/1/2' }],
      },
    },
  },
  {
    name: 'eventbridge-rule AWS::Events::Rule',
    provider: () => new EventBridgeRuleProvider(),
    resourceType: 'AWS::Events::Rule',
    properties: {
      Name: 'rule',
      ScheduleExpression: 'rate(1 hour)',
      Targets: [{ Id: 't1', Arn: 'arn:aws:sqs:us-east-1:123456789012:q' }],
    },
    clients: [EventBridgeClient],
    main: 'PutRuleCommand',
    aux: 'PutTargetsCommand',
    responses: { PutRuleCommand: { RuleArn: 'arn:aws:events:us-east-1:123456789012:rule/rule' } },
  },
  {
    name: 'iam-role AWS::IAM::Role',
    provider: () => new IAMRoleProvider(),
    resourceType: 'AWS::IAM::Role',
    properties: {
      RoleName: 'role',
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] },
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
    },
    clients: [IAMClient],
    main: 'CreateRoleCommand',
    mainAwsError: { name: 'EntityAlreadyExistsException', message: 'Role with name role already exists.' },
    aux: 'AttachRolePolicyCommand',
    responses: {
      CreateRoleCommand: { Role: { RoleName: 'role', RoleId: 'AROA1', Arn: 'arn:aws:iam::123456789012:role/role' } },
    },
  },
  {
    name: 'iam-user-group AWS::IAM::User',
    provider: () => new IAMUserGroupProvider(),
    resourceType: 'AWS::IAM::User',
    properties: { UserName: 'user', LoginProfile: { Password: 'Passw0rd!Passw0rd!' } },
    clients: [IAMClient],
    main: 'CreateUserCommand',
    mainAwsError: { name: 'EntityAlreadyExistsException', message: 'User with name user already exists.' },
    aux: 'CreateLoginProfileCommand',
    responses: { CreateUserCommand: { User: { UserName: 'user', Arn: 'arn:aws:iam::123456789012:user/user' } } },
  },
  {
    name: 'iam-user-group AWS::IAM::Group',
    provider: () => new IAMUserGroupProvider(),
    resourceType: 'AWS::IAM::Group',
    properties: { GroupName: 'group', ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] },
    clients: [IAMClient],
    main: 'CreateGroupCommand',
    mainAwsError: { name: 'EntityAlreadyExistsException', message: 'Group with name group already exists.' },
    aux: 'AttachGroupPolicyCommand',
    responses: { CreateGroupCommand: { Group: { GroupName: 'group', Arn: 'arn:aws:iam::123456789012:group/group' } } },
  },
  {
    name: 'iam-instance-profile AWS::IAM::InstanceProfile',
    provider: () => new IAMInstanceProfileProvider(),
    resourceType: 'AWS::IAM::InstanceProfile',
    properties: { InstanceProfileName: 'profile', Roles: ['role'] },
    clients: [IAMClient],
    main: 'CreateInstanceProfileCommand',
    mainAwsError: { name: 'EntityAlreadyExistsException', message: 'Instance Profile profile already exists.' },
    aux: 'AddRoleToInstanceProfileCommand',
    responses: {
      CreateInstanceProfileCommand: {
        InstanceProfile: { InstanceProfileName: 'profile', Arn: 'arn:aws:iam::123456789012:instance-profile/profile' },
      },
    },
  },
  {
    name: 'iam-managed-policy AWS::IAM::ManagedPolicy',
    provider: () => new IAMManagedPolicyProvider(),
    resourceType: 'AWS::IAM::ManagedPolicy',
    properties: {
      ManagedPolicyName: 'policy',
      PolicyDocument: { Version: '2012-10-17', Statement: [] },
      Roles: ['role'],
    },
    clients: [IAMClient],
    main: 'CreatePolicyCommand',
    mainAwsError: { name: 'EntityAlreadyExistsException', message: 'A policy called policy already exists. Duplicate names are not allowed.' },
    aux: 'AttachRolePolicyCommand',
    responses: { CreatePolicyCommand: { Policy: { Arn: 'arn:aws:iam::123456789012:policy/policy' } } },
  },
  {
    name: 'iam-access-key AWS::IAM::AccessKey',
    provider: () => new IAMAccessKeyProvider(),
    resourceType: 'AWS::IAM::AccessKey',
    properties: { UserName: 'user', Status: 'Inactive' },
    clients: [IAMClient],
    main: 'CreateAccessKeyCommand',
    aux: 'UpdateAccessKeyCommand',
    responses: {
      CreateAccessKeyCommand: { AccessKey: { AccessKeyId: 'AKIA1', SecretAccessKey: 'secret' } },
    },
  },
  {
    name: 'kms AWS::KMS::Key',
    provider: () => new KMSProvider(),
    resourceType: 'AWS::KMS::Key',
    properties: { EnableKeyRotation: true },
    clients: [KMSClient],
    main: 'CreateKeyCommand',
    aux: 'EnableKeyRotationCommand',
    responses: {
      CreateKeyCommand: { KeyMetadata: { KeyId: 'k1', Arn: 'arn:aws:kms:us-east-1:123456789012:key/k1' } },
    },
  },
  {
    name: 'logs-loggroup AWS::Logs::LogGroup',
    provider: () => new LogsLogGroupProvider(),
    resourceType: 'AWS::Logs::LogGroup',
    properties: { LogGroupName: 'lg', RetentionInDays: 7 },
    clients: [CloudWatchLogsClient, STSClient],
    main: 'CreateLogGroupCommand',
    aux: 'PutRetentionPolicyCommand',
    responses: { GetCallerIdentityCommand: { Account: '123456789012' } },
    mainCollisionNotRaised:
      'CreateLogGroup ResourceAlreadyExistsException is ADOPTED, never thrown',
  },
  {
    // The target group is the proxy's own; this resource's create is the
    // target REGISTRATION, and the pool-config call before it is auxiliary.
    name: 'rds-dbproxy-targetgroup AWS::RDS::DBProxyTargetGroup',
    provider: () => new RDSDBProxyTargetGroupProvider(),
    resourceType: 'AWS::RDS::DBProxyTargetGroup',
    properties: {
      DBProxyName: 'proxy',
      TargetGroupName: 'default',
      ConnectionPoolConfigurationInfo: { MaxConnectionsPercent: 50 },
      DBInstanceIdentifiers: ['db1'],
    },
    clients: [RDSClient],
    main: 'RegisterDBProxyTargetsCommand',
    aux: 'ModifyDBProxyTargetGroupCommand',
    auxRunsFirst: true,
  },
  {
    name: 's3-bucket AWS::S3::Bucket',
    provider: () => new S3BucketProvider(),
    resourceType: 'AWS::S3::Bucket',
    properties: { BucketName: 'bucket', VersioningConfiguration: { Status: 'Enabled' } },
    clients: [S3Client, STSClient],
    main: 'CreateBucketCommand',
    aux: 'PutBucketVersioningCommand',
    responses: { GetCallerIdentityCommand: { Account: '123456789012' } },
    mainCollisionNotRaised:
      'CreateBucket BucketAlreadyOwnedByYou is ADOPTED; BucketAlreadyExists is deliberately unclassified (#3816)',
  },
  {
    name: 'servicediscovery AWS::ServiceDiscovery::Service',
    provider: () => new ServiceDiscoveryProvider(),
    resourceType: 'AWS::ServiceDiscovery::Service',
    properties: { Name: 'svc', NamespaceId: 'ns-1', ServiceAttributes: { K: 'v' } },
    clients: [ServiceDiscoveryClient, STSClient],
    main: 'CreateServiceCommand',
    mainAwsError: { name: 'ServiceAlreadyExists', message: 'Service already exists.' },
    aux: 'UpdateServiceAttributesCommand',
    responses: {
      CreateServiceCommand: {
        Service: { Id: 'srv-1', Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-1' },
      },
      GetCallerIdentityCommand: { Account: '123456789012' },
    },
  },
  {
    name: 'sns-topic AWS::SNS::Topic',
    provider: () => new SNSTopicProvider(),
    resourceType: 'AWS::SNS::Topic',
    properties: {
      TopicName: 'topic',
      Subscription: [{ Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:123456789012:q' }],
    },
    clients: [SNSClient],
    main: 'CreateTopicCommand',
    aux: 'SubscribeCommand',
    responses: { CreateTopicCommand: { TopicArn: 'arn:aws:sns:us-east-1:123456789012:topic' } },
  },
  {
    // No main create at all: every AWS call acts on something other than the
    // custom resource. The handler invoke is failed here.
    name: 'custom-resource AWS::CloudFormation::CustomResource',
    provider: () => new CustomResourceProvider(),
    resourceType: 'AWS::CloudFormation::CustomResource',
    properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:handler' },
    clients: [LambdaClient, S3Client, SNSClient, STSClient],
    aux: 'InvokeCommand',
    auxRunsFirst: true,
    responses: {
      GetCallerIdentityCommand: { Account: '123456789012' },
      GetFunctionCommand: { Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } },
    },
  },
  {
    name: 'ssm-parameter AWS::SSM::Parameter',
    provider: () => new SSMParameterProvider(),
    resourceType: 'AWS::SSM::Parameter',
    properties: { Name: 'param', Type: 'String', Value: 'v', Tags: { k: 'v' } },
    clients: [SSMClient, STSClient],
    main: 'PutParameterCommand',
    mainAwsError: { name: 'ParameterAlreadyExists', message: 'The parameter already exists. To overwrite this value, set the overwrite option in the request to true.' },
    aux: 'AddTagsToResourceCommand',
    responses: { GetCallerIdentityCommand: { Account: '123456789012' } },
  },
];

function stubClients(c: Case, failing: string): string[] {
  const sent: string[] = [];
  for (const client of c.clients) {
    vi.spyOn(client.prototype as Sendable, 'send').mockImplementation(async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      sent.push(name);
      if (name === failing) {
        const real = failing === c.aux ? c.auxAwsError : c.mainAwsError;
        throw real !== undefined
          ? awsSdkError(real.message, real.name)
          : awsSdkError(`${COLLISION_TEXT}.`, 'AlreadyExistsException');
      }
      return structuredClone(c.responses?.[name] ?? {});
    });
  }
  return sent;
}

async function createError(c: Case): Promise<unknown> {
  return c
    .provider()
    .create(LOGICAL_ID, c.resourceType, structuredClone(c.properties))
    .then(
      () => undefined,
      (e: unknown) => e
    );
}

describe('auxiliary create failures do not classify as a name collision (#3826)', () => {
  beforeEach(() => {
    vi.stubEnv('AWS_REGION', 'us-east-1');
  });

  function applyEnv(c: Case): void {
    for (const [k, v] of Object.entries(c.env ?? {})) vi.stubEnv(k, v);
  }
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe.each(CASES)('$name', (c) => {
    it(`an "already exists" from ${c.aux} is not credited to the resource`, async () => {
      applyEnv(c);
      const sent = stubClients(c, c.aux);
      const error = await createError(c);

      // The auxiliary call was REACHED, after the main create succeeded (or,
      // for a call made before it, with the main create never sent).
      expect(sent).toContain(c.aux);
      if (c.main !== undefined) {
        if (c.auxRunsFirst === true) expect(sent).not.toContain(c.main);
        else expect(sent).toContain(c.main);
      }
      expect(error).toBeInstanceOf(Error);
      // The top-level message still RELAYS a collision signature and the chain
      // still holds an AWS-authored "already exists": nothing was reworded, so
      // the mark alone is what keeps the verdict false.
      expect(isNameCollisionError((error as Error).message)).toBe(true);
      expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(false);
    });

    const main = c.main;
    it.skipIf(main === undefined || c.mainCollisionNotRaised !== undefined)(`an "already exists" from ${main ?? '(no main create)'} still classifies`, async () => {
      if (main === undefined) return;
      applyEnv(c);
      const sent = stubClients(c, main);
      const error = await createError(c);

      expect(sent).toContain(main);
      if (c.auxRunsFirst !== true) expect(sent).not.toContain(c.aux);
      expect(isNameCollisionErrorFrom(error, LOGICAL_ID)).toBe(true);
    });
  });
});

describe('markAuxiliaryFailure', () => {
  it('anchors the SDK error to an id no template can spell', () => {
    const aws = awsSdkError(`${COLLISION_TEXT}.`);
    const top = new ProvisioningError(`Failed: ${aws.message}`, 'AWS::X::Y', 'Owner', 'p', aws);
    expect(isNameCollisionErrorFrom(top, 'Owner')).toBe(true);

    expect(markAuxiliaryFailure(top, 'Owner')).toBe(top);

    expect(isNameCollisionErrorFrom(top, 'Owner')).toBe(false);
    // The owner's wrapper keeps its id; the mark lands on the link beneath it.
    expect(top.logicalId).toBe('Owner');
    expect((aws as { logicalId?: unknown }).logicalId).toBe(auxiliaryLogicalId('Owner'));
    expect(auxiliaryLogicalId('Owner')).not.toMatch(/^[A-Za-z0-9]+$/);
    // Non-enumerable: it never reaches a serialized record.
    expect(Object.keys(aws)).not.toContain('logicalId');
    expect(JSON.stringify(aws)).not.toContain('auxiliary');
  });

  it('marks a bare caught SDK error directly', () => {
    const aws = awsSdkError(`${COLLISION_TEXT}.`);
    markAuxiliaryFailure(aws, 'Owner');
    const top = new ProvisioningError(`Failed: ${aws.message}`, 'AWS::X::Y', 'Owner', 'p', aws);
    expect(isNameCollisionErrorFrom(top, 'Owner')).toBe(false);
  });

  it('marks beneath a chain of owner wrappers, at the depth the classifier walks', () => {
    const aws = awsSdkError(`${COLLISION_TEXT}.`);
    const inner = new ProvisioningError(`Inner: ${aws.message}`, 'AWS::X::Y', 'Owner', 'p', aws);
    const middle = new ProvisioningError(`Middle: ${aws.message}`, 'AWS::X::Y', 'Owner', 'p', inner);
    const outer = new ProvisioningError(`Outer: ${aws.message}`, 'AWS::X::Y', 'Owner', 'p', middle);
    // The SDK error sits at depth 4, the deepest link the classifier's
    // 5-link walk reads.
    const top = new ProvisioningError(`Failed: ${aws.message}`, 'AWS::X::Y', 'Owner', 'p', outer);
    expect(isNameCollisionErrorFrom(top, 'Owner')).toBe(true);

    markAuxiliaryFailure(top, 'Owner');

    expect(isNameCollisionErrorFrom(top, 'Owner')).toBe(false);
    expect((aws as { logicalId?: unknown }).logicalId).toBe(auxiliaryLogicalId('Owner'));
  });

  it('marks a non-Error link, which the classifier also reads', () => {
    // A plain object whose NAME the classifier credits on its own.
    const link = { name: 'DuplicateTargetGroupNameException', message: 'dup' };
    const top = new ProvisioningError('Failed: dup', 'AWS::X::Y', 'Owner', 'p', link as never);
    expect(isNameCollisionErrorFrom(top, 'Owner')).toBe(true);

    markAuxiliaryFailure(top, 'Owner');

    expect(isNameCollisionErrorFrom(top, 'Owner')).toBe(false);
  });

  it('is idempotent: a marked chain gains no second mark', () => {
    const below = awsSdkError(`${COLLISION_TEXT}.`);
    const aws = Object.assign(awsSdkError(`${COLLISION_TEXT}.`), { cause: below });
    markAuxiliaryFailure(aws, 'Owner');
    markAuxiliaryFailure(aws, 'Other');
    expect((aws as { logicalId?: unknown }).logicalId).toBe(auxiliaryLogicalId('Owner'));
    expect(Object.getOwnPropertyDescriptor(below, 'logicalId')).toBeUndefined();
  });

  it('leaves primitives, frozen errors and a fixed non-string logicalId alone, without throwing', () => {
    expect(markAuxiliaryFailure('text', 'Owner')).toBe('text');
    expect(markAuxiliaryFailure(undefined, 'Owner')).toBeUndefined();

    const frozen = Object.freeze(awsSdkError(`${COLLISION_TEXT}.`));
    expect(markAuxiliaryFailure(frozen, 'Owner')).toBe(frozen);
    expect((frozen as { logicalId?: unknown }).logicalId).toBeUndefined();

    const fixed = awsSdkError(`${COLLISION_TEXT}.`);
    Object.defineProperty(fixed, 'logicalId', { value: 7, configurable: false });
    expect(markAuxiliaryFailure(fixed, 'Owner')).toBe(fixed);
    expect((fixed as { logicalId?: unknown }).logicalId).toBe(7);
  });
});

/**
 * Population fence: every `markAuxiliaryFailure(` call site in a provider file
 * has a CASES row for that file, and every row's file has as many sites. A new
 * wiring without a case, or a case whose site was deleted, fails here.
 *
 * The scan runs once at collection time over the REAL tree.
 */
const PROVIDERS_DIR = join(import.meta.dirname, '../../../src/provisioning/providers');
const MARK_CALL = /\bmarkAuxiliaryFailure\(/g;
const markSitesByFile: ReadonlyMap<string, number> = new Map(
  readdirSync(PROVIDERS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => {
      // Comments are BLANKED by a real parser, not dropped by line: a call
      // after a closed block comment on the same line is still a site.
      const code = codeLines(readFileSync(join(PROVIDERS_DIR, f), 'utf8'), f)
        .map((l) => l.text)
        .join('\n');
      return [f, code.match(MARK_CALL)?.length ?? 0] as const;
    })
    .filter(([, n]) => n > 0)
);

describe('the wiring and the CASES table cover the same population (#3826)', () => {
  it(
    'has one CASES row per markAuxiliaryFailure call site, file by file',
    () => {
      const casesByFile = new Map<string, number>();
      for (const c of CASES) {
        const file = `${c.name.split(' ')[0]}-provider.ts`;
        casesByFile.set(file, (casesByFile.get(file) ?? 0) + 1);
      }
      // Floors: an empty or collapsed scan would make the equality vacuous.
      expect(markSitesByFile.size).toBeGreaterThanOrEqual(20);
      expect([...markSitesByFile.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30);
      expect(Object.fromEntries([...casesByFile].sort())).toEqual(
        Object.fromEntries([...markSitesByFile].sort())
      );
      // The label's stem must name the file the case's provider class lives
      // in, or swapping two labels keeps every per-file count equal.
      const misfiled = CASES.filter((c) => {
        const file = `${c.name.split(' ')[0]}-provider.ts`;
        const source = readFileSync(join(PROVIDERS_DIR, file), 'utf8');
        return !source.includes(`export class ${c.provider().constructor.name} `);
      }).map((c) => c.name);
      expect(misfiled).toEqual([]);
    },
    CONTENDED_CASE_TIMEOUT_MS
  );
});

describe('the mark survives maskSecretsInError (auxiliary-failure.ts header)', () => {
  it('keeps the anchor on the masked clone', () => {
    const aws = awsSdkError(`${COLLISION_TEXT} for s3cr3tvalue.`);
    const top = new ProvisioningError(`Failed: ${aws.message}`, 'AWS::X::Y', 'Owner', 'p', aws);
    markAuxiliaryFailure(top, 'Owner');

    const masked = maskSecretsInError(top, new Map(), (t) => t.replace('s3cr3tvalue', '***'));

    // A real clone: the masking rewrote the chain rather than returning it.
    expect(masked).not.toBe(top);
    const maskedCause = masked.cause as Error;
    expect(maskedCause).not.toBe(aws);
    expect(maskedCause.message).not.toContain('s3cr3tvalue');
    expect(Object.getOwnPropertyDescriptor(maskedCause, 'logicalId')).toMatchObject({
      value: auxiliaryLogicalId('Owner'),
      enumerable: false,
    });
    expect(isNameCollisionError(masked.message)).toBe(true);
    expect(isNameCollisionErrorFrom(masked, 'Owner')).toBe(false);
  });
});
