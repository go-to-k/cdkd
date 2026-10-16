import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { AgentRuntimeArtifact, Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';
import type { Construct } from 'constructs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Must match `ROLE_NAME` / `PARAM_NAME` / `PARAM_VALUE` in verify.sh. */
export const ROLE_NAME = 'cdkd-integ-engine-role-identity-noperm';
export const PARAM_NAME = '/cdkd-integ/local-engine-role-identity/secret';
export const PARAM_VALUE = 'caller-identity-3240-ok';

/**
 * Run this fixture's Lambdas at the HOST's CPU architecture: a function that
 * declares none defaults to X86_64, and an arm64 host then runs every
 * container under CPU emulation (see
 * `tests/unit/integ-fixture-host-architecture.test.ts`).
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;
const HOST_PLATFORM =
  process.arch === 'arm64' ? ecr_assets.Platform.LINUX_ARM64 : ecr_assets.Platform.LINUX_AMD64;

/**
 * The deployed half of the `--role-arn` workload-identity integ (issue #3240).
 *
 *   - `NoPermissionRole`: trusts the account root and carries NO policy, so
 *     whatever runs as it is denied every AWS call.
 *   - `SecretParam`: a plain `String` SSM parameter with a known, NON-secret
 *     test value. The ECS secret in the synth-only stack points at it by name;
 *     only the caller can read it. Nothing secret is written to cdkd state or
 *     to the state bucket, so verify.sh needs no object-version sweep.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::SSM::Parameter
 */
export class LocalEngineRoleIdentityRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'NoPermissionRole', {
      roleName: ROLE_NAME,
      assumedBy: new iam.AccountRootPrincipal(),
    });

    new ssm.StringParameter(this, 'SecretParam', {
      parameterName: PARAM_NAME,
      stringValue: PARAM_VALUE,
    });

    new cdk.CfnOutput(this, 'NoPermissionRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'SecretParamName', { value: PARAM_NAME });
  }
}

/**
 * The synth-only half: one workload per engine command, each reporting which
 * identity it runs as. Never deployed; `cdkd local start-*` only reads the
 * synthesized template.
 *
 *   - `Alb` (start-alb): a Lambda target group whose function echoes its
 *     `AWS_ACCESS_KEY_ID`.
 *   - `Dist` (start-cloudfront): a Lambda Function URL origin, same echo.
 *   - `Agent` (start-agentcore): an AgentCore runtime whose container echoes
 *     the same value on POST /invocations.
 *   - `SecretService` (start-service): a task whose container receives
 *     `ROLE_TEST_SECRET` from the SSM parameter above and prints it, so
 *     verify.sh can read it from the container log.
 *
 * covers: AWS::ElasticLoadBalancingV2::LoadBalancer
 * covers: AWS::CloudFront::Distribution
 * covers: AWS::BedrockAgentCore::Runtime
 * covers: AWS::ECS::Service
 * covers: AWS::Lambda::Function
 */
export class LocalEngineRoleIdentityAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ALB handler: the ALB Lambda-target response shape.
    const albFn = new lambda.Function(this, 'AlbFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'exports.handler = async () => ({',
          '  statusCode: 200,',
          "  statusDescription: '200 OK',",
          '  isBase64Encoded: false,',
          "  headers: { 'content-type': 'application/json' },",
          '  body: JSON.stringify({ akid: process.env.AWS_ACCESS_KEY_ID || null }),',
          '});',
        ].join('\n')
      ),
      timeout: cdk.Duration.seconds(10),
    });
    albFn.addPermission('AlbInvoke', {
      principal: new iam.ServicePrincipal('elasticloadbalancing.amazonaws.com'),
    });
    // L1 ELBv2 keeps the fixture VPC-free; the emulator reads only the shape.
    const loadBalancer = new elbv2.CfnLoadBalancer(this, 'Alb', { type: 'application' });
    const targetGroup = new elbv2.CfnTargetGroup(this, 'AlbTargetGroup', {
      targetType: 'lambda',
      targets: [{ id: albFn.functionArn }],
    });
    new elbv2.CfnListener(this, 'AlbListener', {
      loadBalancerArn: loadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [{ type: 'forward', targetGroupArn: targetGroup.ref }],
    });

    // CloudFront handler: the Function URL (payload v2.0) response shape.
    const originFn = new lambda.Function(this, 'OriginFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        [
          'exports.handler = async () => ({',
          '  statusCode: 200,',
          "  headers: { 'content-type': 'application/json' },",
          '  body: JSON.stringify({ akid: process.env.AWS_ACCESS_KEY_ID || null }),',
          '});',
        ].join('\n')
      ),
      timeout: cdk.Duration.seconds(10),
    });
    const fnUrl = originFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new cloudfront.Distribution(this, 'Dist', {
      defaultBehavior: { origin: new origins.FunctionUrlOrigin(fnUrl) },
    });

    new Runtime(this, 'Agent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: HOST_PLATFORM,
      }),
    });

    // ECS: the container receives the SSM parameter as an env var; the
    // emulator fetches it with the identity under test.
    const cluster = new ecs.CfnCluster(this, 'Cluster', {
      clusterName: 'cdkd-local-engine-role-identity',
    });
    // L1, with a LITERAL ValueFrom ARN built from the concrete env: the
    // emulator drops an intrinsic-valued secret (`Fn::Join` over the partition)
    // unless --from-state is passed. The `aws` partition is fixed on purpose.
    const taskDef = new ecs.CfnTaskDefinition(this, 'SecretTask', {
      family: 'cdkd-local-engine-role-identity',
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'web',
          image: 'public.ecr.aws/docker/library/busybox:1.36',
          essential: true,
          entryPoint: ['/bin/sh', '-c'],
          command: ['while true; do echo "ROLE_SECRET_SEEN=${ROLE_TEST_SECRET}"; sleep 2; done'],
          memoryReservation: 16,
          secrets: [
            {
              name: 'ROLE_TEST_SECRET',
              valueFrom: `arn:aws:ssm:${this.region}:${this.account}:parameter${PARAM_NAME}`,
            },
          ],
        },
      ],
    });
    new ecs.CfnService(this, 'SecretService', {
      cluster: cluster.ref,
      taskDefinition: taskDef.ref,
      desiredCount: 1,
      launchType: 'EC2',
    });
  }
}
