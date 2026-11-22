import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import type { Construct } from 'constructs';

/**
 * `AWS::Lambda::Function` `AcceleratorConfig` on the SDK route (issue #6352).
 *
 *   covers: AWS::Lambda::Function
 *   covers: AWS::Lambda::CapacityProvider
 *
 * GPU memory applies to a container-image function on a GPU Lambda Managed
 * Instances capacity provider (x86_64, GPU instance types only, in a VPC).
 * aws-cdk-lib's `CfnFunction` does not model the property yet, hence the
 * override. The image is a one-file Python handler: nothing here needs a model
 * or a GPU workload, only the configuration AWS reports back.
 *
 * - default: `AcceleratorMemorySize` 12.
 * - `CDKD_TEST_UPDATE=true`: 6, an in-place change.
 * - `CDKD_TEST_REMOVAL=true`: no AcceleratorConfig, which update() refuses
 *   before any call (no UpdateFunctionConfiguration value removes it).
 */
export class LambdaAcceleratorConfigStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updating = process.env['CDKD_TEST_UPDATE'] === 'true';
    const removal = process.env['CDKD_TEST_REMOVAL'] === 'true';

    // The smallest GPU footprint: one isolated subnet and 4-vCPU GPU types
    // (16 GB T4 / 24 GB A10G / 24 GB L4), so one instance fits an 8-vCPU G
    // quota. Lambda Managed Instances accepted a single subnet and these
    // xlarge types (measured in us-east-1, 2026-11-21).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
    const sg = new ec2.SecurityGroup(this, 'LmiSg', { vpc });

    // Named, so verify.sh's cleanup can delete it without reading state.
    const provider = new lambda.CapacityProvider(this, 'GpuProvider', {
      capacityProviderName: `${this.stackName}-gpu`,
      subnets: vpc.isolatedSubnets,
      securityGroups: [sg],
      architectures: [lambda.Architecture.X86_64],
      instanceTypeFilter: lambda.InstanceTypeFilter.allow([
        new ec2.InstanceType('g4dn.xlarge'),
        new ec2.InstanceType('g5.xlarge'),
        new ec2.InstanceType('g6.xlarge'),
      ]),
    });

    const fn = new lambda.DockerImageFunction(this, 'GpuFn', {
      code: lambda.DockerImageCode.fromImageAsset('gpu-image', {
        platform: Platform.LINUX_AMD64,
      }),
      architecture: lambda.Architecture.X86_64,
      memorySize: 4096,
      timeout: cdk.Duration.seconds(30),
    });
    provider.addFunction(fn, {
      publishToLatestPublished: true,
      latestPublishedScalingConfig: { minExecutionEnvironments: 1, maxExecutionEnvironments: 1 },
    });
    if (!removal) {
      (fn.node.defaultChild as lambda.CfnFunction).addPropertyOverride('AcceleratorConfig', {
        AcceleratorMemorySize: updating ? 6 : 12,
      });
    }

    new cdk.CfnOutput(this, 'ProviderArn', { value: provider.capacityProviderArn });
  }
}
