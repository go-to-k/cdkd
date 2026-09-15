import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * Lambda Managed Instances with a capacity provider that declares NO
 * `capacityProviderName` (issue #3174).
 *
 * `AWS::Lambda::CapacityProvider` has no SDK provider, so it goes through
 * Cloud Control, which fails the create with `Resource Handler Internal
 * Failure` when the name is omitted. cdkd now generates one. The function is
 * attached so the provider actually launches instances, which is what the
 * destroy has to tear down.
 *
 * covers: AWS::Lambda::CapacityProvider
 * covers: AWS::Lambda::Function
 */
export class LambdaCapacityProviderDefaultNameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });
    const sg = new ec2.SecurityGroup(this, 'LmiSg', { vpc });

    // Deliberately no `capacityProviderName`: the case under test.
    const provider = new lambda.CapacityProvider(this, 'Provider', {
      subnets: vpc.isolatedSubnets,
      securityGroups: [sg],
      architectures: [lambda.Architecture.ARM_64],
    });
    // A second unnamed provider with NO function attached, so it launches no
    // instances. verify.sh phase 2b rewrites its state record to point at a
    // provider created out of band under a DIFFERENT name: the update phase
    // then patches a provider whose live name is not the generated one, the
    // case where sending the generated name is a refused create-only change.
    const spare = new lambda.CapacityProvider(this, 'SpareProvider', {
      subnets: vpc.isolatedSubnets,
      securityGroups: [sg],
      architectures: [lambda.Architecture.ARM_64],
    });
    // Update phase: a tag is a mutable property, so the next deploy goes
    // through the Cloud Control UPDATE path for both providers.
    if (process.env.CDKD_TEST_UPDATE === 'true') {
      cdk.Tags.of(provider).add('cdkd-integ-phase', 'update');
      cdk.Tags.of(spare).add('cdkd-integ-phase', 'update');
    }

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_13,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 2048,
      timeout: cdk.Duration.minutes(1),
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context):\n    return {}\n'),
    });
    provider.addFunction(fn, { publishToLatestPublished: true });

    new cdk.CfnOutput(this, 'ProviderArn', { value: provider.capacityProviderArn });
  }
}
