import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Stack that uses Vpc.fromLookup() to trigger the context provider loop.
 *
 * This tests that cdkd's self-implemented synthesis correctly handles:
 * 1. First synthesis → missing context detected (vpc-provider)
 * 2. Context provider resolves VPC info via EC2 SDK calls
 * 3. Saves result to cdk.context.json
 * 4. Re-synthesis with resolved context → success
 */
export class VpcLookupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Look up the default VPC — this triggers the context provider loop
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // Use the looked-up VPC info to prove it was resolved
    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: `/cdkd-test/vpc-lookup/${this.stackName}/vpc-id`,
      stringValue: vpc.vpcId,
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
    });

    new cdk.CfnOutput(this, 'AvailabilityZones', {
      value: vpc.availabilityZones.join(','),
    });
  }
}
