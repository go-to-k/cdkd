import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { CfnMicrovmImage } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two Lambda MicroVM images the way a CDK user writes one today, copied from
 * cdk-local's `tests/integration/local-start-microvm` fixture (the L1, code
 * from an `s3assets.Asset` of a directory holding a Dockerfile plus the app):
 *
 * - `Image`: every lifecycle hook ENABLED on port 9001, and an
 *   EnvironmentVariables entry the app echoes.
 * - `NeverReadyImage`: the same code with NEVER_READY=1, so its /ready hook
 *   answers 503 forever and its 3-second ReadyTimeoutInSeconds expires.
 *
 * Nothing is deployed: `cdkd local start-microvm` reads the synthesized template and
 * the staged asset directory in cdk.out.
 */
export class LocalStartMicrovmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const code = new s3assets.Asset(this, 'Code', { path: path.join(here, '..', 'app') });
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    const image = (rid: string, env: Record<string, string>, readyTimeout: number): CfnMicrovmImage =>
      new CfnMicrovmImage(this, rid, {
        name: `cdkd-integ-${rid.toLowerCase()}`,
        description: 'cdkd local start-microvm fixture image',
        baseImageArn: cdk.Fn.sub(
          'arn:${AWS::Partition}:lambda:${AWS::Region}:aws:microvm-image:al2023-1'
        ),
        baseImageVersion: '1',
        buildRoleArn: buildRole.roleArn,
        codeArtifact: { uri: code.s3ObjectUrl },
        cpuConfigurations: [{ architecture: 'ARM_64' }],
        resources: [],
        additionalOsCapabilities: [],
        egressNetworkConnectors: [],
        logging: {},
        environmentVariables: Object.entries(env).map(([key, value]) => ({ key, value })),
        hooks: {
          port: 9001,
          microvmImageHooks: {
            ready: 'ENABLED',
            readyTimeoutInSeconds: readyTimeout,
            validate: 'ENABLED',
            validateTimeoutInSeconds: 30,
          },
          microvmHooks: {
            run: 'ENABLED',
            runTimeoutInSeconds: 10,
            suspend: 'ENABLED',
            suspendTimeoutInSeconds: 10,
            resume: 'ENABLED',
            resumeTimeoutInSeconds: 10,
            terminate: 'ENABLED',
            terminateTimeoutInSeconds: 10,
          },
        },
      });

    image('Image', { GREETING: 'hello-from-microvm' }, 60);
    image('NeverReadyImage', { GREETING: 'never', NEVER_READY: '1' }, 3);
  }
}
