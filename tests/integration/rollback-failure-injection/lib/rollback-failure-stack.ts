import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Rich, multi-resource stack for exercising cdkd's deploy-engine ROLLBACK
 * path against real AWS (issue #808 / deploy-engine rollback regression net).
 *
 * The existing rollback coverage is only the trivial `basic` single-SQS
 * `CDKD_TEST_FAIL` injection. This fixture is deliberately interdependent so
 * that several siblings COMPLETE before the failure fires — giving rollback
 * real work to do (delete a VPC + Subnets + SecurityGroup + an IAM Role + a
 * Lambda-in-VPC + an SSM Parameter) and letting verify.sh assert against real
 * AWS that every rolled-back sibling is gone (no leftover hyperplane ENIs /
 * SGs / the VPC).
 *
 * Resources (all created on a clean deploy):
 *   - VPC (1 AZ, 1 NAT GW, public + private subnets)
 *   - SecurityGroup for the Lambda
 *   - IAM Role (Lambda execution role) + its managed-policy attachment
 *   - Lambda function deployed into the VPC private subnet
 *   - SSM Parameter (a cheap, fast scalar that completes early)
 *
 * Failure injection (SELF-CONTAINED — does NOT reuse the `basic` fixture's
 * CDKD_TEST_FAIL plumbing): when `ROLLBACK_INTEG_FAIL=true`, a deliberately
 * invalid SQS Queue is added. SQS `messageRetentionPeriod` must be in
 * [60, 1209600]; 9999999 is out of range and AWS rejects CreateQueue. The
 * failing queue is wired to DEPEND ON the fast siblings (IAM Role + SSM
 * Parameter) so those two are guaranteed COMPLETE before the queue is even
 * dispatched (event-driven DAG: a node only dispatches once all its deps
 * finish) — guaranteeing rollback has already-created siblings to delete.
 * The slow VPC/Lambda branch runs in parallel and is also rolled back.
 */
export class RollbackFailureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Deterministic, NON-reserved tag applied to every resource in this stack
    // (verify.sh filters the EC2 VPC / SecurityGroup by it). cdkd's EC2 provider
    // only forwards template-supplied `Tags`, and AWS reserves the `aws:` prefix,
    // so cdkd never sets `aws:cdk:path` on a VPC/SG — a `tag:aws:cdk:path` filter
    // would always return empty, falsely failing the "VPC created" assertion and
    // vacuously passing the "VPC gone" assertions. This own-tag is reliable.
    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-failure-injection');

    // --- VPC + Security Group (slow branch) ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'cdkd rollback-failure-injection fixture SG',
    });

    // --- IAM Role (fast sibling) ---
    const role = new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'cdkd rollback-failure-injection fixture Lambda execution role',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
    });

    // --- Lambda in VPC (slow branch, depends on VPC + SG + Role) ---
    new lambda.Function(this, 'VpcFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context): return {"statusCode": 200}'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      role,
    });

    // --- SSM Parameter (fast sibling, no dependencies) ---
    const param = new ssm.StringParameter(this, 'Marker', {
      parameterName: `${this.stackName}-marker`,
      stringValue: 'rollback-integ-marker',
      description: 'Marker parameter for the rollback-failure-injection integration test',
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId, description: 'VPC ID' });
    new cdk.CfnOutput(this, 'SecurityGroupId', {
      value: sg.securityGroupId,
      description: 'Security Group ID',
    });
    new cdk.CfnOutput(this, 'RoleArn', { value: role.roleArn, description: 'Lambda role ARN' });

    // --- Self-contained failure injection (gated on ROLLBACK_INTEG_FAIL) ---
    // Out-of-range messageRetentionPeriod (valid range is [60, 1209600]).
    // AWS rejects CreateQueue, so the deploy fails. We make the failing queue
    // depend on the two FAST siblings (Role + SSM Parameter) so they are
    // guaranteed already-created when the failure fires — rollback must then
    // delete them (plus the parallel VPC/Lambda branch).
    if (process.env.ROLLBACK_INTEG_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(role);
      failing.node.addDependency(param);
    }
  }
}
