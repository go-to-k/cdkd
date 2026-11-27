import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as batch from 'aws-cdk-lib/aws-batch';

/**
 * AWS Batch example stack (Fargate)
 *
 * Demonstrates:
 * - VPC with public subnet (1 AZ, no NAT for cost saving)
 * - Batch Compute Environment (Fargate type)
 * - Batch Job Queue
 * - Batch Job Definition (container with Fargate)
 * - IAM Execution Role for ECS tasks
 * - Resource dependencies (Compute Env → Job Queue, Role → Job Definition)
 *
 * Uses L1 (Cfn) constructs for Batch resources.
 *
 * UPDATE (CDKD_TEST_UPDATE=true, go-to-k/cdkd#7098): the Fargate environment's
 * `ComputeResources.Type` goes FARGATE -> FARGATE_SPOT with no
 * `ReplaceComputeEnvironment`, so it is REPLACED (Batch refuses it in place);
 * the job queue that references it must follow. An EC2 environment with
 * `ReplaceComputeEnvironment: false` (min 0 vCPUs, so no instance runs) changes
 * `InstanceTypes` and must be UPDATED in place.
 */
export class BatchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const updating = process.env.CDKD_TEST_UPDATE === 'true';

    // VPC with 1 AZ and public subnet only (no NAT for cost saving)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Security Group for Batch Compute Environment
    const sg = new ec2.SecurityGroup(this, 'BatchSecurityGroup', {
      vpc,
      description: 'Security group for Batch Fargate compute environment',
      allowAllOutbound: true,
    });

    // ECS Task Execution Role (required for Fargate tasks to pull images)
    const executionRole = new iam.Role(this, 'BatchExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'EcsTaskExecPolicy',
          'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });

    // Batch Compute Environment (Fargate)
    const computeEnv = new batch.CfnComputeEnvironment(this, 'ComputeEnv', {
      type: 'MANAGED',
      computeResources: {
        type: updating ? 'FARGATE_SPOT' : 'FARGATE',
        maxvCpus: 2,
        subnets: vpc.publicSubnets.map((s) => s.subnetId),
        securityGroupIds: [sg.securityGroupId],
      },
    });

    // EC2 compute environment updated in place (go-to-k/cdkd#7098).
    const instanceRole = new iam.Role(this, 'Ec2InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          'EcsForEc2Policy',
          'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role'
        ),
      ],
    });
    const instanceProfile = new iam.CfnInstanceProfile(this, 'Ec2InstanceProfile', {
      roles: [instanceRole.roleName],
    });
    const ec2Env = new batch.CfnComputeEnvironment(this, 'Ec2ComputeEnv', {
      type: 'MANAGED',
      replaceComputeEnvironment: false,
      computeResources: {
        type: 'EC2',
        allocationStrategy: 'BEST_FIT_PROGRESSIVE',
        minvCpus: 0,
        maxvCpus: 2,
        instanceTypes: updating ? ['m5.large'] : ['optimal'],
        subnets: vpc.publicSubnets.map((s) => s.subnetId),
        securityGroupIds: [sg.securityGroupId],
        instanceRole: instanceProfile.attrArn,
      },
    });

    // Batch Job Queue
    const jobQueue = new batch.CfnJobQueue(this, 'JobQueue', {
      priority: 1,
      computeEnvironmentOrder: [
        {
          order: 1,
          computeEnvironment: computeEnv.ref,
        },
      ],
    });

    // Batch Job Definition (Fargate container)
    const jobDef = new batch.CfnJobDefinition(this, 'JobDef', {
      type: 'container',
      platformCapabilities: ['FARGATE'],
      containerProperties: {
        image: 'public.ecr.aws/amazonlinux/amazonlinux:2023',
        command: ['echo', 'Hello from AWS Batch!'],
        resourceRequirements: [
          { type: 'VCPU', value: '0.25' },
          { type: 'MEMORY', value: '512' },
        ],
        executionRoleArn: executionRole.roleArn,
        networkConfiguration: {
          assignPublicIp: 'ENABLED',
        },
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ComputeEnvironmentArn', {
      value: computeEnv.attrComputeEnvironmentArn,
      description: 'Batch Compute Environment ARN',
    });

    new cdk.CfnOutput(this, 'Ec2ComputeEnvironmentArn', {
      value: ec2Env.attrComputeEnvironmentArn,
    });

    new cdk.CfnOutput(this, 'JobQueueArn', {
      value: jobQueue.attrJobQueueArn,
      description: 'Batch Job Queue ARN',
    });

    new cdk.CfnOutput(this, 'JobDefinitionArn', {
      value: jobDef.ref,
      description: 'Batch Job Definition ARN',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    new cdk.CfnOutput(this, 'ExecutionRoleArn', {
      value: executionRole.roleArn,
      description: 'ECS Task Execution Role ARN',
    });
  }
}
