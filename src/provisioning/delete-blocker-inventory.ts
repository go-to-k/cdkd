/**
 * What CloudFormation's delete handler removes, or waits for, BEFORE it
 * deletes a resource of each SDK-provider type, and how cdkd's `delete()`
 * meets each one (go-to-k/cdkd#6715).
 *
 * A "blocker" is something the plain delete call refuses over, or leaves
 * behind, that the handler clears first: attachments, replica regions,
 * running instances, targets. A provider whose `delete()` sends only the
 * plain call fails, or leaves the resource, where the AWS CDK CLI succeeds
 * (#6466, #5323). Data a handler REFUSES over (a non-empty bucket) is not a
 * blocker: the parity there is the refusal.
 *
 * Every registered SDK-provider type is a row here or on
 * {@link UNAUDITED_DELETE_BLOCKER_TYPES}; `tests/unit/provisioning/
 * delete-blocker-inventory.test.ts` enforces it, and checks each `handled`
 * blocker's site and unit test exist. Adding a provider means reading its
 * type's handler and adding a row.
 *
 * Evidence, strongest first: the handler source where it is open
 * (`aws-cloudformation/aws-cloudformation-resource-providers-*`), the
 * registry schema's `handlers.delete.permissions` (a removal permission the
 * handler holds is a removal it can make; one it lacks is one it cannot), and
 * the service API reference for the delete call's precondition. A permission
 * list cannot show a delete-call PARAMETER that clears a blocker
 * (`ForceDelete`, `EnforceConsumerDeletion`), so a type whose delete call has
 * one is settled by its API reference or left unaudited.
 *
 * Preparation never removes more than the handler does unless the row's
 * `beyondCfn` says what and why.
 *
 * Data only; nothing on the deploy or destroy path imports it.
 */

/** How cdkd meets one blocker. */
export type DeleteBlockerDisposition =
  | {
      /** `delete()` clears it first. */
      readonly kind: 'handled';
      /** The repo-relative file holding the preparation. */
      readonly site: string;
      /**
       * A literal in `site` naming the preparation (an SDK command, a
       * helper). The check reads the whole file outside comments and
       * imports, so prefer one only the delete path spells; the test title
       * is what pins the behavior.
       */
      readonly call: string;
      readonly test: {
        /** The repo-relative unit test file. */
        readonly file: string;
        /** The `it(...)` title, verbatim. */
        readonly title: string;
        /** For an `it.each` row: its case label, verbatim. */
        readonly caseLabel?: string;
      };
    }
  | {
      /** `delete()` refuses, naming the blocker and the next step. */
      readonly kind: 'refused';
      readonly site: string;
      /** Text the refusal carries, verbatim from `site`. */
      readonly message: string;
    }
  | {
      /** Not yet met; the issue tracks it. */
      readonly kind: 'open';
      readonly issue: number;
    };

export interface DeleteBlocker {
  /** What the handler removes or waits for. */
  readonly blocker: string;
  readonly disposition: DeleteBlockerDisposition;
}

export interface DeleteBlockerRow {
  readonly type: string;
  /** Where the handler's behavior was read (an https URL, then detail). */
  readonly source: string;
  /** Empty: the handler removes nothing before its delete. */
  readonly blockers: readonly DeleteBlocker[];
  /** What cdkd's `delete()` removes that the handler does not, and why. */
  readonly beyondCfn?: readonly string[];
}

const SCHEMA = 'https://schema.cloudformation.us-east-1.amazonaws.com/CloudformationSchema.zip';

/** The registry schema's delete permissions for `type`, as evidence. */
function perms(list: string): string {
  return `${SCHEMA} handlers.delete.permissions: ${list}`;
}

/** A type whose handler removes nothing before its delete. */
function none(type: string, source: string, beyondCfn?: readonly string[]): DeleteBlockerRow {
  return beyondCfn ? { type, source, blockers: [], beyondCfn } : { type, source, blockers: [] };
}

function handled(
  blocker: string,
  site: string,
  call: string,
  file: string,
  title: string,
  caseLabel?: string
): DeleteBlocker {
  const test = caseLabel ? { file, title, caseLabel } : { file, title };
  return { blocker, disposition: { kind: 'handled', site, call, test } };
}

function refused(blocker: string, site: string, message: string): DeleteBlocker {
  return { blocker, disposition: { kind: 'refused', site, message } };
}

const P = 'src/provisioning/providers/';
const T = 'tests/unit/provisioning/';
const IAM_STARTED = `${T}iam-delete-started-4946.test.ts`;
const USER_STRIP = '%s, then DeleteUser refused: unconfirmed';
const GROUP_STRIP = '%s, then DeleteGroup refused: unconfirmed';

/**
 * Types not yet audited. SHRINK-ONLY: the test pins its length, so a new
 * provider cannot join it unnoticed. Empty since #6751's live probes.
 */
export const UNAUDITED_DELETE_BLOCKER_TYPES: readonly string[] = [];

export const DELETE_BLOCKER_INVENTORY: readonly DeleteBlockerRow[] = [
  // --- IAM ---
  {
    type: 'AWS::IAM::Role',
    source: perms(
      'iam:DetachRolePolicy, iam:DeleteRolePolicy (no iam:RemoveRoleFromInstanceProfile)'
    ),
    blockers: [
      handled(
        'attached managed policies',
        `${P}iam-role/delete.ts`,
        'DetachRolePolicyCommand',
        `${T}iam-role-provider.test.ts`,
        'should detach managed policies before deleting role'
      ),
      handled(
        'inline policies',
        `${P}iam-role/delete.ts`,
        'DeleteRolePolicyCommand',
        `${T}iam-role-provider.test.ts`,
        'should delete inline policies before deleting role'
      ),
      // The handler cannot remove it either: CloudFormation fails with DeleteConflict.
      refused(
        // go-to-k/cdkd#6770 / #6808: on every delete, a same-name
        // re-create's delete-first and a rollback's included; the wording
        // names the run.
        'an instance profile outside the stack still holding the role (destroy, removal, replacement, re-create)',
        `${P}iam-role/delete.ts`,
        'did not delete (a profile created outside the stack, or'
      ),
    ],
    beyondCfn: [
      "on a same-name re-create's or a rollback's delete only, removes the role from the stack's own instance profiles, those its records name, where DeleteRole would refuse with DeleteConflict (#6770, #6808)",
    ],
  },
  {
    type: 'AWS::IAM::ManagedPolicy',
    source: perms(
      'iam:ListEntitiesForPolicy, iam:DetachRolePolicy, iam:DetachGroupPolicy, iam:DetachUserPolicy, iam:ListPolicyVersions, iam:DeletePolicyVersion'
    ),
    blockers: [
      handled(
        'attachments to roles, groups and users',
        `${P}iam-managed-policy-provider.ts`,
        'DetachRolePolicyCommand',
        `${T}iam-managed-policy-provider.test.ts`,
        'detaches every principal AWS-side and deletes non-default versions before DeletePolicy'
      ),
      handled(
        'non-default policy versions',
        `${P}iam-managed-policy-provider.ts`,
        'DeletePolicyVersionCommand',
        `${T}iam-managed-policy-provider.test.ts`,
        'detaches every principal AWS-side and deletes non-default versions before DeletePolicy'
      ),
    ],
  },
  {
    type: 'AWS::IAM::InstanceProfile',
    source: perms('iam:GetInstanceProfile, iam:RemoveRoleFromInstanceProfile'),
    blockers: [
      handled(
        'its roles',
        `${P}iam-instance-profile-provider.ts`,
        'RemoveRoleFromInstanceProfileCommand',
        IAM_STARTED,
        'a role removed, then DeleteInstanceProfile refused: unconfirmed'
      ),
    ],
  },
  {
    type: 'AWS::IAM::User',
    source: perms(
      'iam:RemoveUserFromGroup, iam:DetachUserPolicy, iam:DeleteUserPolicy, iam:DeleteLoginProfile, iam:DeleteAccessKey'
    ),
    blockers: [
      handled(
        'group memberships',
        `${P}iam-user-group/user-delete.ts`,
        'RemoveUserFromGroupCommand',
        IAM_STARTED,
        USER_STRIP,
        'removed from a group'
      ),
      handled(
        'attached managed policies',
        `${P}iam-user-group/user-delete.ts`,
        'DetachUserPolicyCommand',
        IAM_STARTED,
        USER_STRIP,
        'a managed policy detached'
      ),
      handled(
        'inline policies',
        `${P}iam-user-group/user-delete.ts`,
        'DeleteUserPolicyCommand',
        IAM_STARTED,
        USER_STRIP,
        'an inline policy deleted'
      ),
      handled(
        'the login profile',
        `${P}iam-user-group/user-delete.ts`,
        'DeleteLoginProfileCommand',
        IAM_STARTED,
        USER_STRIP,
        'the login profile deleted'
      ),
      handled(
        'access keys',
        `${P}iam-user-group/user-delete.ts`,
        'DeleteAccessKeyCommand',
        IAM_STARTED,
        USER_STRIP,
        'an access key deleted'
      ),
    ],
    beyondCfn: ['deletes the permissions boundary, which DeleteUser does not need removed'],
  },
  {
    type: 'AWS::IAM::Group',
    source: perms('iam:DetachGroupPolicy, iam:DeleteGroupPolicy (no iam:RemoveUserFromGroup)'),
    blockers: [
      handled(
        'attached managed policies',
        `${P}iam-user-group/group.ts`,
        'DetachGroupPolicyCommand',
        IAM_STARTED,
        GROUP_STRIP,
        'a managed policy detached'
      ),
      handled(
        'inline policies',
        `${P}iam-user-group/group.ts`,
        'DeleteGroupPolicyCommand',
        IAM_STARTED,
        GROUP_STRIP,
        'an inline policy deleted'
      ),
      // The handler cannot remove it either: CloudFormation fails with DeleteConflict.
      refused(
        // go-to-k/cdkd#6770 / #6808: as the role's.
        'a user outside the stack still in the group (destroy, removal, replacement, re-create)',
        `${P}iam-user-group/group.ts`,
        'did not remove (a user added outside the stack, one '
      ),
    ],
    beyondCfn: [
      "on a same-name re-create's or a rollback's delete only, removes the stack's own member users, those its records name, where DeleteGroup would refuse a group with users (#6750, #6808)",
    ],
  },
  none(
    'AWS::IAM::Policy',
    perms('iam:DeleteRolePolicy, iam:DeleteUserPolicy, iam:DeleteGroupPolicy (the delete itself)')
  ),
  none(
    'AWS::IAM::AccessKey',
    'https://docs.aws.amazon.com/IAM/latest/APIReference/API_DeleteAccessKey.html (no registry delete handler; DeleteAccessKey has no precondition)'
  ),
  none(
    'AWS::IAM::UserToGroupAddition',
    'https://docs.aws.amazon.com/IAM/latest/APIReference/API_RemoveUserFromGroup.html (no registry delete handler; the delete is RemoveUserFromGroup)'
  ),

  // --- Secrets, data stores ---
  {
    type: 'AWS::SecretsManager::Secret',
    source: perms('secretsmanager:DescribeSecret, secretsmanager:RemoveRegionsFromReplication'),
    blockers: [
      handled(
        'replica regions',
        `${P}secretsmanager-secret/delete.ts`,
        'RemoveRegionsFromReplicationCommand',
        `${T}secretsmanager-secret-provider-delete-replicas-5323.test.ts`,
        'removes every replica region, then deletes the primary'
      ),
    ],
  },
  {
    type: 'AWS::DynamoDB::GlobalTable',
    source: perms(
      'dynamodb:Describe*, dynamodb:DeleteTable, application-autoscaling:DeleteScalingPolicy, application-autoscaling:DeleteScheduledAction, application-autoscaling:DeregisterScalableTarget'
    ),
    blockers: [
      handled(
        'replicas in other regions',
        `${P}dynamodb-globaltable/delete.ts`,
        'dropReplicaForDelete',
        `${T}dynamodb-globaltable-provider-roundtrip.test.ts`,
        'drops non-local replicas via UpdateTable Delete before DeleteTable'
      ),
      handled(
        'application autoscaling targets and policies',
        `${P}dynamodb-globaltable/autoscaling.ts`,
        'DeregisterScalableTargetCommand',
        `${T}dynamodb-globaltable-provider-roundtrip.test.ts`,
        'tears down autoscaling targets BEFORE DeleteTable (regression PR #403 blocker — orphan leak)'
      ),
    ],
  },
  none('AWS::DynamoDB::Table', perms('dynamodb:DeleteTable, dynamodb:DescribeTable')),
  none(
    'AWS::Kinesis::Stream',
    'https://docs.aws.amazon.com/kinesis/latest/APIReference/API_DeleteStream.html (#6751 probe: with a consumer registered out of band, the stack delete failed with "DeleteStream can\'t delete ... because there are consumers associated with this data stream", so the handler does not set EnforceConsumerDeletion)',
    [
      'deletes every registered consumer (EnforceConsumerDeletion), which the handler refuses over; a consumer cannot outlive its stream',
    ]
  ),
  none(
    'AWS::Kinesis::StreamConsumer',
    perms('kinesis:DeregisterStreamConsumer (the delete itself)')
  ),
  {
    type: 'AWS::RDS::DBCluster',
    source:
      'https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-rds/blob/5a410e843efb90076c1c4d322707bc989e5a058b/aws-rds-dbcluster/src/main/java/software/amazon/rds/dbcluster/DeleteHandler.java#L47-L61 (RemoveFromGlobalCluster when GlobalClusterIdentifier is set; no member-instance delete. The current registry schema also lists rds:DeleteDBInstance, yet in the #6751 probe the stack delete of a cluster with an out-of-band member failed with "Cluster can\'t be deleted. It still contains DB instances in a non-deleting state")',
    blockers: [
      handled(
        'global cluster membership',
        `${P}rds/cluster-delete.ts`,
        'RemoveFromGlobalClusterCommand',
        `${T}rds-provider-global-member-delete-4029.test.ts`,
        'detaches by ARN, waits until it left the member list, then deletes without a snapshot'
      ),
    ],
    beyondCfn: [
      'deletes the express-configuration writer instance it recorded, which the express API requires gone first (#5984)',
    ],
  },
  none(
    'AWS::RDS::DBInstance',
    'https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-rds/blob/5a410e843efb90076c1c4d322707bc989e5a058b/aws-rds-dbinstance/src/main/java/software/amazon/rds/dbinstance/DeleteHandler.java#L61-L62 (a single DeleteDBInstance)'
  ),
  none('AWS::RDS::DBSubnetGroup', perms('rds:DeleteDBSubnetGroup, rds:DescribeDBSubnetGroups')),
  none('AWS::RDS::DBProxy', perms('rds:DescribeDBProxies, rds:DeleteDBProxy')),
  none(
    'AWS::RDS::DBProxyEndpoint',
    perms('rds:DescribeDBProxyEndpoints, rds:DeleteDBProxyEndpoint')
  ),
  none('AWS::RDS::DBProxyTargetGroup', perms('rds:DeregisterDBProxyTargets (the delete itself)')),
  none(
    'AWS::DocDB::DBCluster',
    'https://docs.aws.amazon.com/documentdb/latest/developerguide/API_DeleteDBCluster.html (no registry delete permissions. #6751 probe, from CloudTrail: with an out-of-band member instance the handler sent only DescribeDBClusters and DeleteDBCluster, and the stack delete failed with "Cluster can\'t be deleted. It still contains DB instances". For a global-cluster member it sent DeleteDBCluster with no RemoveFromGlobalCluster)',
    [
      'detaches a cluster recording a GlobalClusterIdentifier from its global cluster before DeleteDBCluster, which the handler does not',
    ]
  ),
  none('AWS::DocDB::DBSubnetGroup', perms('rds:DeleteDBSubnetGroup')),
  none('AWS::DocDB::DBInstance', perms('rds:DeleteDBInstance, rds:DescribeDBInstances')),
  none('AWS::Neptune::DBSubnetGroup', perms('rds:DeleteDBSubnetGroup, rds:DescribeDBSubnetGroups')),
  none(
    'AWS::Neptune::DBCluster',
    perms(
      'rds:DeleteDBCluster, rds:DeleteDBInstance, rds:RemoveFromGlobalCluster (#6751 probe: with an out-of-band member instance the stack delete failed with "Cluster can\'t be deleted. It still contains DB instances", so the handler deletes no member. CloudTrail shows it detaching a global-cluster member first; a declared GlobalClusterIdentifier routes the type to Cloud Control, which keeps that delete)'
    )
  ),
  none(
    'AWS::Neptune::DBInstance',
    perms('rds:DeleteDBInstance, rds:DescribeDBInstances, rds:CreateDBSnapshot')
  ),
  none('AWS::ElastiCache::SubnetGroup', perms('elasticache:DeleteCacheSubnetGroup')),
  none(
    'AWS::ElastiCache::CacheCluster',
    perms(
      'elasticache:DeleteCacheCluster, elasticache:CreateSnapshot (a final snapshot, not a blocker)'
    )
  ),
  {
    type: 'AWS::EFS::FileSystem',
    source: perms(
      'elasticfilesystem:DeleteReplicationConfiguration, elasticfilesystem:DescribeReplicationConfigurations (#6751 probe, with the replication configuration added out of band, since a declared ReplicationConfiguration routes the type to Cloud Control: DeleteFileSystem refuses a replication source with FileSystemInUse; the handler deleted the configuration, polled until ReplicationNotFound, then deleted the file system, leaving the destination standing. A destination-only file system was not probed)'
    ),
    blockers: [
      // Only the configuration it is the SOURCE of; a destination's refusal stands.
      handled(
        'the replication configuration it is the source of',
        `${P}efs/file-system.ts`,
        'DeleteReplicationConfigurationCommand',
        `${T}efs-delete-replication-6751.test.ts`,
        'deletes its own replication configuration after a FileSystemInUse refusal, waits for the teardown, then deletes'
      ),
    ],
  },
  none(
    'AWS::FSx::FileSystem',
    'https://docs.aws.amazon.com/fsx/latest/APIReference/API_DeleteFileSystem.html (no registry delete handler. #6751 probe: for a PERSISTENT_2 Lustre file system with a data repository association added out of band, CloudTrail shows the handler sending only DeleteFileSystem with no per-type configuration, and the delete succeeded. ONTAP, Windows and OpenZFS were not probed)'
  ),
  none('AWS::EFS::MountTarget', perms('elasticfilesystem:DeleteMountTarget')),
  none('AWS::EFS::AccessPoint', perms('elasticfilesystem:DeleteAccessPoint')),
  {
    type: 'AWS::ECR::Repository',
    source:
      'https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-ecr/blob/6f18348c737eedc3770fd5a17ac1f7d0b58aef54/aws-ecr-repository/src/main/java/software/amazon/ecr/repository/Translator.java#L100-L106 (DeleteRepository force = EmptyOnDelete)',
    blockers: [
      handled(
        'its images, when EmptyOnDelete is true',
        `${P}ecr-provider.ts`,
        'EmptyOnDelete',
        `${T}providers/ecr-provider-delete-data-guard.test.ts`,
        'force-deletes when EmptyOnDelete: true is in the properties'
      ),
    ],
  },
  none('AWS::S3::Bucket', perms('s3:DeleteBucket, s3:ListBucket (a non-empty bucket is refused)')),
  none('AWS::S3::BucketPolicy', perms('s3:GetBucketPolicy, s3:DeleteBucketPolicy')),
  none('AWS::S3Express::DirectoryBucket', perms('s3express:DeleteBucket')),
  none(
    'AWS::S3Tables::TableBucket',
    perms(
      's3tables:DeleteTableBucket (a bucket holding tables or namespaces is refused, as cdkd refuses one since #6766, emptying it only under --force-stateful-recreation)'
    )
  ),
  none('AWS::S3Tables::Namespace', perms('s3tables:DeleteNamespace')),
  none('AWS::S3Tables::Table', perms('s3tables:GetTable, s3tables:DeleteTable')),
  none(
    'AWS::S3Vectors::VectorBucket',
    perms(
      's3vectors:GetVectorBucket, s3vectors:DeleteVectorBucket (a bucket holding vector indexes is refused, as cdkd refuses one since #6766, emptying it only under --force-stateful-recreation)'
    )
  ),
  none('AWS::SQS::Queue', perms('sqs:DeleteQueue, sqs:GetQueueAttributes')),
  none('AWS::SQS::QueuePolicy', perms('sqs:SetQueueAttributes (the delete itself)')),
  none(
    'AWS::SNS::Topic',
    perms('sns:GetTopicAttributes, sns:DeleteTopic (DeleteTopic removes the subscriptions)')
  ),
  none('AWS::SNS::Subscription', perms('sns:Unsubscribe (the delete itself)')),
  none('AWS::SNS::TopicPolicy', perms('sns:SetTopicAttributes (the delete itself)')),
  none('AWS::SSM::Parameter', perms('ssm:DeleteParameter')),
  none(
    'AWS::KMS::Key',
    'https://github.com/aws-cloudformation/aws-cloudformation-resource-providers-kms/blob/master/key/src/main/java/software/amazon/kms/key/DeleteHandler.java#L38 (ScheduleKeyDeletion only)'
  ),
  none('AWS::KMS::Alias', perms('kms:DeleteAlias')),
  none(
    'AWS::KinesisFirehose::DeliveryStream',
    perms(
      'firehose:DeleteDeliveryStream, kms:RevokeGrant (a grant, not a precondition of the delete)'
    )
  ),

  // --- Compute, containers ---
  {
    type: 'AWS::AutoScaling::AutoScalingGroup',
    source: perms(
      'autoscaling:UpdateAutoScalingGroup, autoscaling:DeleteAutoScalingGroup, autoscaling:Describe*'
    ),
    blockers: [
      handled(
        'running instances (scaled to 0 first)',
        `${P}asg/delete.ts`,
        'scaleInThenDelete',
        `${T}providers/asg-delete-scale-in-6466.test.ts`,
        'scales the group to 0, waits for its instances to terminate, then deletes it without ForceDelete'
      ),
    ],
  },
  {
    type: 'AWS::ECS::Service',
    source:
      'https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DeleteService.html (force deletes a service with running tasks; handler permissions: ecs:DeleteService, ecs:DescribeServices)',
    blockers: [
      handled(
        'running tasks (a forced delete)',
        `${P}ecs/service-delete.ts`,
        'force: true',
        `${T}ecs-provider.test.ts`,
        'should scale down to 0 then delete with force'
      ),
    ],
    beyondCfn: [
      'scales the service to desiredCount 0 before the forced delete, which stops the same tasks',
    ],
  },
  none('AWS::ECS::Cluster', perms('ecs:DeleteCluster, ecs:DescribeClusters')),
  none('AWS::ECS::TaskDefinition', perms('ecs:DeregisterTaskDefinition (the delete itself)')),
  none(
    'AWS::EC2::Instance',
    perms('ec2:TerminateInstances, ec2:Describe*, ssm:DescribeAssociation, ssm:ListAssociations'),
    [
      "deletes the instance's own declared SSM associations, which CloudFormation leaves on the terminated instance",
    ]
  ),
  {
    type: 'AWS::EC2::EIP',
    source:
      'https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ReleaseAddress.html (a non-default VPC address must be disassociated first; handler permissions include ec2:DisassociateAddress)',
    blockers: [
      // The handler may disassociate ANY association; cdkd meets only its
      // own, and AWS's refusal stands for one another resource made.
      handled(
        'the association its own InstanceId made',
        `${P}ec2/igw-eip.ts`,
        'disassociateOwnAssociation',
        `${T}ec2-eip-delete-disassociate-6715.test.ts`,
        'disassociates its own instance association after an InUse refusal, then releases'
      ),
    ],
  },
  none('AWS::EC2::VPC', perms('ec2:DeleteVpc, ec2:DescribeVpcs')),
  none('AWS::EC2::Subnet', perms('ec2:DescribeSubnets, ec2:DeleteSubnet'), [
    'deletes Lambda-managed ENIs still in the subnet while DeleteSubnet reports a dependency',
  ]),
  none(
    'AWS::EC2::SecurityGroup',
    perms('ec2:DescribeSecurityGroups, ec2:DeleteSecurityGroup, ec2:DescribeInstances'),
    [
      'deletes Lambda-managed ENIs still on the group while DeleteSecurityGroup reports a dependency',
    ]
  ),
  none(
    'AWS::EC2::InternetGateway',
    perms('ec2:DeleteInternetGateway (the attachment is its own resource)')
  ),
  none(
    'AWS::EC2::VPCGatewayAttachment',
    perms('ec2:DetachInternetGateway, ec2:DetachVpnGateway (the delete itself)')
  ),
  none('AWS::EC2::NatGateway', perms('ec2:DeleteNatGateway, ec2:DescribeNatGateways')),
  none(
    'AWS::EC2::VPCEndpoint',
    perms(
      'ec2:DeleteVpcEndpoints, ec2:DescribeVpcEndpoints, ec2:DeleteTags (the endpoint is deleted with its network interfaces and route-table entries; the handler, like delete(), waits until it is gone)'
    )
  ),
  none('AWS::EC2::RouteTable', perms('ec2:DeleteRouteTable')),
  none('AWS::EC2::Route', perms('ec2:DeleteRoute')),
  none(
    'AWS::EC2::SubnetRouteTableAssociation',
    perms('ec2:DisassociateRouteTable (the delete itself)')
  ),
  none(
    'AWS::EC2::SecurityGroupIngress',
    perms('ec2:RevokeSecurityGroupIngress (the delete itself)')
  ),
  none('AWS::EC2::NetworkAcl', perms('ec2:DeleteNetworkAcl, ec2:DeleteTags')),
  none('AWS::EC2::NetworkAclEntry', perms('ec2:DeleteNetworkAclEntry')),
  none(
    'AWS::EC2::SubnetNetworkAclAssociation',
    perms('ec2:ReplaceNetworkAclAssociation (the delete itself)')
  ),
  none(
    'AWS::EMR::Cluster',
    perms('elasticmapreduce:TerminateJobFlows, elasticmapreduce:DescribeCluster')
  ),
  {
    type: 'AWS::EMR::InstanceGroupConfig',
    source: perms(
      "elasticmapreduce:ModifyInstanceGroups, elasticmapreduce:RemoveAutoScalingPolicy (#6751 probe: CloudTrail shows the handler sending RemoveAutoScalingPolicy, then ModifyInstanceGroups to 0. Without the removal the scale-in still succeeds, but the policy's alarm and scaling target outlive the group. cdkd removes only a declared AutoScalingPolicy; one attached out of band stays)"
    ),
    blockers: [
      handled(
        'an automatic scaling policy',
        `${P}emr-instance-group-config/remove-scaling-policy.ts`,
        'RemoveAutoScalingPolicyCommand',
        `${T}emr-instance-group-delete-scaling-policy-6751.test.ts`,
        'removes the automatic scaling policy before scaling the TASK group to 0'
      ),
    ],
  },
  none(
    'AWS::EMR::InstanceFleetConfig',
    perms('elasticmapreduce:ModifyInstanceFleet (the resize to 0 is the delete)')
  ),
  none(
    'AWS::BedrockAgentCore::Runtime',
    perms(
      'bedrock-agentcore:DeleteAgentRuntime, bedrock-agentcore:DeleteAgentRuntimeEndpoint, bedrock-agentcore:DeleteWorkloadIdentity (#6751 probe: with an endpoint added out of band, the stack delete failed with "This agent has endpoints that must be deleted before the agent can be removed", as a plain DeleteAgentRuntime does; the service deleted the workload identity with the runtime)'
    )
  ),
  none(
    'AWS::BedrockAgentCore::Browser',
    `${SCHEMA} (NON_PROVISIONABLE: a read-only schema of the AWS-owned default browser, with no delete handler)`
  ),
  none(
    'AWS::BedrockAgentCore::CodeInterpreter',
    `${SCHEMA} (NON_PROVISIONABLE: a read-only schema of the AWS-owned default code interpreter, with no delete handler)`
  ),
  none('AWS::BedrockAgentCore::Evaluator', perms('bedrock-agentcore:DeleteEvaluator')),
  none(
    'AWS::Lambda::Function',
    perms(
      'lambda:DeleteFunction, lambda:GetFunction, ec2:DescribeNetworkInterfaces (#6751 probe: deleting a VPC function, the handler only polled DescribeNetworkInterfaces until Lambda itself deleted the ENI, then completed; CloudTrail shows no handler DeleteNetworkInterface)'
    ),
    [
      "detaches the VPC config, then deletes the function's ENIs Lambda leaves behind, where the handler waits for Lambda to release them",
    ]
  ),
  none('AWS::Lambda::Permission', perms('lambda:RemovePermission (the delete itself)')),
  none('AWS::Lambda::Url', perms('lambda:DeleteFunctionUrlConfig')),
  none(
    'AWS::Lambda::EventSourceMapping',
    perms('lambda:DeleteEventSourceMapping, lambda:GetEventSourceMapping')
  ),
  none('AWS::Lambda::LayerVersion', perms('lambda:DeleteLayerVersion')),
  none('AWS::Lambda::EventInvokeConfig', perms('lambda:DeleteFunctionEventInvokeConfig')),
  none('AWS::Lambda::MicrovmImage', perms('lambda:DeleteMicrovmImage')),
  none('AWS::Lambda::WebFunctionRevision', perms('lambda:DeleteWebFunctionRevision')),
  none('AWS::Lambda::WebFunctionEndpoint', perms('lambda:DeleteWebFunctionEndpoint')),
  none('AWS::Lambda::NetworkConnector', perms('lambda:DeleteNetworkConnector')),
  none('AWS::StepFunctions::StateMachine', perms('states:DeleteStateMachine')),
  none(
    'AWS::Pipes::Pipe',
    perms('pipes:DeletePipe, pipes:DescribePipe, logs:DeleteLogDelivery (service-managed delivery)')
  ),
  none('AWS::Scheduler::Schedule', perms('scheduler:DeleteSchedule')),

  // --- Events, logs, monitoring ---
  {
    type: 'AWS::Events::Rule',
    source: perms('events:ListTargetsByRule, events:RemoveTargets, events:DeleteRule'),
    blockers: [
      handled(
        'its targets',
        `${P}eventbridge-rule/delete.ts`,
        'RemoveTargetsCommand',
        `${T}eventbridge-rule-provider.test.ts`,
        'should remove targets and delete rule'
      ),
    ],
  },
  none(
    'AWS::Events::EventBus',
    perms(
      'events:DeleteEventBus, events:RemovePermission, events:UpdateEventBus (a policy does not block the delete; rules do, and are refused)'
    )
  ),
  none('AWS::Events::Archive', perms('events:DeleteArchive')),
  none(
    'AWS::Connect::Instance',
    perms(
      "connect:DeleteInstance, connect:DescribeInstance, connect:UntagResource, ds:DeleteDirectory, ds:UnauthorizeApplication, ds:DescribeDirectories (the ds:* grants serve DeleteInstance removing the Connect-managed directory itself; the instance's storage configs, flows and integrations are records of their own, deleted first)"
    )
  ),
  none(
    'AWS::Logs::LogGroup',
    perms(
      'logs:DeleteLogGroup, logs:DeleteDataProtectionPolicy (the group is deleted with its policy)'
    )
  ),
  none('AWS::Logs::DeliverySource', perms('logs:DeleteDeliverySource')),
  none('AWS::Logs::Delivery', perms('logs:DeleteDelivery')),
  none(
    'AWS::Logs::DeliveryDestination',
    "https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_DeleteDeliveryDestination.html (#6751 probe: DeleteDeliveryDestination succeeded with a delivery destination policy attached, and the policy went with it; the handler's logs:DeleteDeliveryDestinationPolicy clears nothing the delete needs)"
  ),
  none('AWS::CloudWatch::Alarm', perms('cloudwatch:DeleteAlarms')),
  none('AWS::Lightsail::Alarm', perms('lightsail:DeleteAlarm')),
  none(
    'AWS::CloudWatch::AnomalyDetector',
    'https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_DeleteAnomalyDetector.html (no registry delete handler; no precondition)'
  ),
  none('AWS::CloudTrail::Trail', perms('CloudTrail:DeleteTrail'), [
    'stops logging before DeleteTrail',
  ]),
  none('AWS::DLM::LifecyclePolicy', perms('dlm:DeleteLifecyclePolicy')),
  none('AWS::Budgets::Budget', perms('budgets:ModifyBudget')),

  // --- Networking, edge, DNS ---
  {
    type: 'AWS::Route53::HostedZone',
    source: perms(
      'route53:ListQueryLoggingConfigs, route53:DeleteQueryLoggingConfig, route53:UpdateHostedZoneFeatures, route53:DeleteHostedZone (no record deletion)'
    ),
    blockers: [
      handled(
        'its query logging configuration',
        `${P}route53/zone-config.ts`,
        'DeleteQueryLoggingConfigCommand',
        `${T}route53-hosted-zone-delete-started-4946.test.ts`,
        'marks a refused DeleteHostedZone once a query logging config was deleted'
      ),
      handled(
        'accelerated recovery',
        `${P}route53/hosted-zone-delete.ts`,
        'ensureAcceleratedRecoveryDisabledForDelete',
        `${T}route53-provider.test.ts`,
        'disables AcceleratedRecovery and waits for DISABLED before DeleteHostedZone'
      ),
    ],
  },
  none('AWS::Route53::RecordSet', perms('route53:ChangeResourceRecordSets (the delete itself)')),
  none(
    'AWS::Route53::RecordSetGroup',
    'https://docs.aws.amazon.com/Route53/latest/APIReference/API_ChangeResourceRecordSets.html (no registry delete handler; the delete is a DELETE change batch)'
  ),
  {
    type: 'AWS::CloudFront::Distribution',
    source:
      'https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_DeleteDistribution.html (a distribution must be disabled and deployed first; the legacy handler permission list omits UpdateDistribution)',
    blockers: [
      handled(
        'an enabled distribution (disabled, then deployed)',
        `${P}cloudfront-distribution/delete.ts`,
        'UpdateDistributionCommand',
        `${T}cloudfront-distribution-provider.test.ts`,
        'should disable first if enabled, then delete with IfMatch'
      ),
    ],
  },
  none(
    'AWS::CloudFront::CloudFrontOriginAccessIdentity',
    perms('cloudfront:DeleteCloudFrontOriginAccessIdentity')
  ),
  none('AWS::CloudFront::OriginAccessControl', perms('cloudfront:DeleteOriginAccessControl')),
  none(
    'AWS::ElasticLoadBalancingV2::LoadBalancer',
    perms('elasticloadbalancing:DeleteLoadBalancer (deletion protection is not cleared)')
  ),
  none('AWS::ElasticLoadBalancingV2::TargetGroup', perms('elasticloadbalancing:DeleteTargetGroup')),
  none('AWS::ElasticLoadBalancingV2::Listener', perms('elasticloadbalancing:DeleteListener')),
  none('AWS::WAFv2::WebACL', perms('wafv2:DeleteWebACL, wafv2:GetWebACL (no DisassociateWebACL)')),
  none(
    'AWS::CertificateManager::Certificate',
    perms('acm:DeleteCertificate, acm:DescribeCertificate')
  ),
  none(
    'AWS::ServiceDiscovery::PrivateDnsNamespace',
    perms('servicediscovery:DeleteNamespace, servicediscovery:GetOperation')
  ),
  none(
    'AWS::ServiceDiscovery::HttpNamespace',
    perms('servicediscovery:DeleteNamespace, servicediscovery:GetOperation')
  ),
  none(
    'AWS::ServiceDiscovery::PublicDnsNamespace',
    perms('servicediscovery:DeleteNamespace, servicediscovery:GetOperation')
  ),
  none(
    'AWS::ServiceDiscovery::Service',
    perms('servicediscovery:DeleteService (no DeregisterInstance)')
  ),

  // --- API Gateway, AppSync ---
  none('AWS::ApiGateway::Account', perms('apigateway:GET')),
  none('AWS::ApiGateway::Authorizer', perms('apigateway:DELETE')),
  none('AWS::ApiGateway::Resource', perms('apigateway:DELETE')),
  none('AWS::ApiGateway::Deployment', perms('apigateway:GET, apigateway:DELETE')),
  none('AWS::ApiGateway::Stage', perms('apigateway:DELETE')),
  none('AWS::ApiGateway::Method', perms('apigateway:DELETE')),
  none('AWS::ApiGateway::RestApi', perms('apigateway:DELETE')),
  none('AWS::ApiGatewayV2::Api', perms('apigateway:GET, apigateway:DELETE')),
  none('AWS::ApiGatewayV2::Stage', perms('apigateway:DELETE')),
  none('AWS::ApiGatewayV2::Integration', perms('apigateway:GET, apigateway:DELETE')),
  none('AWS::ApiGatewayV2::Route', perms('apigateway:GET, apigateway:DELETE')),
  none('AWS::ApiGatewayV2::Authorizer', perms('apigateway:GET, apigateway:DELETE')),
  none('AWS::AppSync::GraphQLApi', perms('appsync:DeleteGraphqlApi')),
  none('AWS::AppSync::GraphQLSchema', perms('(none listed)')),
  none('AWS::AppSync::DataSource', perms('appsync:DeleteDataSource')),
  none('AWS::AppSync::Resolver', perms('appsync:DeleteResolver')),
  none('AWS::AppSync::ApiKey', perms('appsync:DeleteApiKey')),

  // --- Analytics, developer tools, identity ---
  {
    type: 'AWS::Glue::Crawler',
    source: perms('glue:StopCrawler, glue:DeleteCrawler, glue:GetCrawler'),
    blockers: [
      handled(
        'a running crawl',
        `${P}glue/crawler.ts`,
        'StopCrawlerCommand',
        `${T}providers/glue-provider.test.ts`,
        'delete: stops a running crawler and retries DeleteCrawler'
      ),
    ],
  },
  none(
    'AWS::Glue::Database',
    perms(
      'glue:DeleteDatabase, glue:GetDatabase, glue:DeleteConnection, glue:GetConnection (#6751 probe: with a table added out of band, CloudTrail shows the handler sending only GetDatabase and DeleteDatabase. A FederatedDatabase needs a federation-capable connection and was not probed)'
    )
  ),
  none('AWS::Glue::Table', perms('glue:DeleteTable, glue:GetTable')),
  none('AWS::Glue::Workflow', perms('glue:DeleteWorkflow')),
  none('AWS::Glue::SecurityConfiguration', perms('glue:DeleteSecurityConfiguration')),
  none('AWS::Glue::Job', perms('glue:DeleteJob')),
  none('AWS::Glue::Connection', perms('glue:DeleteConnection')),
  none('AWS::Glue::Trigger', perms('glue:DeleteTrigger')),
  none(
    'AWS::CodeBuild::Project',
    perms(
      'codebuild:DeleteProject, codebuild:BatchGetProjects, codebuild:DeleteWebhook (#6751 probe: with a webhook attached, CloudTrail shows the handler sending only BatchGetProjects and DeleteProject, and DeleteProject succeeds with a webhook)'
    )
  ),
  none('AWS::CodeCommit::Repository', perms('codecommit:DeleteRepository')),
  none(
    'AWS::AppConfig::Environment',
    perms(
      "appconfig:GetEnvironment, appconfig:DeleteEnvironment (#6751 probe: CloudTrail shows the handler's DeleteEnvironment carrying no DeletionProtectionCheck, so the account default applies, as when cdkd sends none)"
    )
  ),
  none(
    'AWS::CloudFormation::Stack',
    perms('cloudformation:DescribeStacks, cloudformation:DeleteStack (the delete itself)')
  ),
  none(
    'AWS::CloudFormation::WaitCondition',
    `${SCHEMA} (NON_PROVISIONABLE: no delete handler; nothing exists in AWS to remove)`
  ),
  none(
    'AWS::CloudFormation::WaitConditionHandle',
    `${SCHEMA} (NON_PROVISIONABLE: no delete handler; the handle is a presigned URL)`,
    ['deletes the signal object cdkd keeps in its state bucket for the handle']
  ),
  none(
    'AWS::Cognito::UserPool',
    perms(
      'cognito-idp:DeleteUserPool (a domain is its own resource; deletion protection is not cleared)'
    )
  ),
];
