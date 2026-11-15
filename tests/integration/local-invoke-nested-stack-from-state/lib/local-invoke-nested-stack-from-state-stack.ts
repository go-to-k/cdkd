import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Run this fixture's Lambdas and the Fargate task at the HOST's CPU
 * architecture, so nothing runs under emulation on an arm64 dev host (see
 * tests/integration/local-start-api/lib/local-start-api-stack.ts).
 */
const IS_ARM = process.arch === 'arm64';
const HOST_ARCHITECTURE = IS_ARM ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;
const HOST_CPU_ARCHITECTURE = IS_ARM ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64;

/** Echoes the env vars the container saw; an API Gateway event gets a 200 with them as the JSON body. */
const HANDLER_CODE = `
exports.handler = async (event) => {
  const env = {
    BUCKET: process.env.BUCKET ?? 'unset',
    QUEUE_URL: process.env.QUEUE_URL ?? 'unset',
    QUEUE_ARN: process.env.QUEUE_ARN ?? 'unset',
    PARENT_BUCKET: process.env.PARENT_BUCKET ?? 'unset',
    ROOT_QUEUE: process.env.ROOT_QUEUE ?? 'unset',
  };
  if (event && (event.httpMethod || event.requestContext)) {
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) };
  }
  return env;
};
`;

function fn(scope: Construct, id: string, environment: Record<string, string>): lambda.Function {
  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline(HANDLER_CODE),
    architecture: HOST_ARCHITECTURE,
    environment,
    timeout: cdk.Duration.seconds(10),
  });
}

/**
 * Fixture for `cdkd local invoke | start-api | run-task --from-state` against
 * resources inside CDK NestedStacks.
 *
 *   Stack (parent)  : sqs.Queue PQ, Lambda OuterFn (QUEUE_URL = parent queue)
 *   Stack/Inner     : s3.Bucket B, Lambda InnerFn (BUCKET / QUEUE_URL / QUEUE_ARN),
 *                     LambdaRestApi on InnerFn, Fargate task definition Task
 *   Stack/Inner/Deeper : Lambda DeepFn (PARENT_BUCKET, ROOT_QUEUE) -- two hops
 *
 * The parent's queue and the nested bucket reach the nested templates as
 * nested-template PARAMETERS that CDK fills from the parent, so resolving them
 * under --from-state needs the parent's cdkd state (the nested stack's own
 * record is `<Parent>~<NestedLogicalId>`).
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SQS::Queue
 * covers: AWS::S3::Bucket
 * covers: AWS::Lambda::Function
 * covers: AWS::ApiGateway::RestApi
 * covers: AWS::ECS::TaskDefinition
 */
export class LocalInvokeNestedStackFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const q = new sqs.Queue(this, 'PQ', { removalPolicy: cdk.RemovalPolicy.DESTROY });

    fn(this, 'OuterFn', { QUEUE_URL: q.queueUrl });

    const inner = new cdk.NestedStack(this, 'Inner');

    const b = new s3.Bucket(inner, 'B', { removalPolicy: cdk.RemovalPolicy.DESTROY });

    const innerFn = fn(inner, 'InnerFn', {
      BUCKET: b.bucketName,
      QUEUE_URL: q.queueUrl,
      QUEUE_ARN: q.queueArn,
    });

    // cloudWatchRole: false -- CDK's default creates a Retain-policy role + account setting that destroy leaves behind.
    new apigw.LambdaRestApi(inner, 'Api', { handler: innerFn, cloudWatchRole: false });

    const task = new ecs.FargateTaskDefinition(inner, 'Task', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: HOST_CPU_ARCHITECTURE,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer('Main', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/busybox:1.36'),
      command: ['sh', '-c', 'echo NESTED_TASK QUEUE_URL=$QUEUE_URL BUCKET=$BUCKET'],
      environment: { QUEUE_URL: q.queueUrl, BUCKET: b.bucketName },
    });

    const deeper = new cdk.NestedStack(inner, 'Deeper');
    fn(deeper, 'DeepFn', { PARENT_BUCKET: b.bucketName, ROOT_QUEUE: q.queueUrl });
  }
}
