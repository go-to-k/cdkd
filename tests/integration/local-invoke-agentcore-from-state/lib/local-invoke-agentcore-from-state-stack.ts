import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Runtime, AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for `cdkd local invoke-agentcore --from-state` (G2 follow-up
 * to PR #717's 3-axis review).
 *
 * One Bedrock AgentCore Runtime + one S3 bucket. The runtime's env carries:
 *
 *   - `BUCKET_NAME = Ref: MyBucket` — INTRINSIC; without `--from-state` the
 *     local-invoke-agentcore path drops it. With `--from-state` after a real
 *     `cdkd deploy`, the deployed bucket name is read from cdkd state and
 *     substituted, so the runtime echoes the literal physical bucket name back.
 *
 *   - `STATIC_VALUE = 'cdkd-static'` — LITERAL; passes through unchanged in
 *     both modes (control case).
 *
 * Bucket carries `removalPolicy: DESTROY` + `autoDeleteObjects: true` so the
 * integ teardown is fully self-contained.
 */
export class LocalInvokeAgentcoreFromStateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'MyBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const runtime = new Runtime(this, 'EchoEnvAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '..', 'agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: {
        BUCKET_NAME: bucket.bucketName,
        STATIC_VALUE: 'cdkd-static',
      },
    });

    new cdk.CfnOutput(this, 'RuntimeArn', { value: runtime.agentRuntimeArn });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
