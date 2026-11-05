import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cxschema from 'aws-cdk-lib/cloud-assembly-schema';
import { Construct } from 'constructs';

/**
 * Stack that uses Vpc.fromLookup() to trigger the context provider loop.
 *
 * This tests that cdkd's synthesis orchestration correctly handles:
 * 1. First synthesis → missing context detected (vpc-provider)
 * 2. Context provider resolves VPC info via EC2 SDK calls
 * 3. Saves result to cdk.context.json
 * 4. Re-synthesis with resolved context → success
 *
 * Plus a lookup that reports its key missing on EVERY synth (go-to-k/cdkd#5805):
 * a construct that never caches its lookup calls `reportMissingContextKey`
 * unconditionally beside `valueFromLookup`. The AWS CDK CLI stops after one
 * round with the same keys and uses that assembly; cdkd used to refuse with
 * "Context resolution made no progress". The parameter does not exist, so the
 * lookup's `ignoreErrorOnMissingContext` + default is what the stack receives.
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

    const parameterName = '/cdkd-test/vpc-lookup/never-created/latest-image-tag';
    const { key } = cdk.ContextProvider.getKey(this, {
      provider: cxschema.ContextProvider.SSM_PARAMETER_PROVIDER,
      props: { parameterName },
    });
    const query: cxschema.SSMParameterContextQuery = {
      account: this.account,
      region: this.region,
      parameterName,
    };
    this.reportMissingContextKey({
      key,
      provider: cxschema.ContextProvider.SSM_PARAMETER_PROVIDER,
      // `dummyValue` / `ignoreErrorOnMissingContext` are what
      // `ContextProvider.getValue` adds too; the schema type does not list them.
      props: {
        ...query,
        dummyValue: 'latest',
        ignoreErrorOnMissingContext: true,
      } as cxschema.SSMParameterContextQuery,
    });
    new cdk.CfnOutput(this, 'AlwaysMissingLookup', {
      value: ssm.StringParameter.valueFromLookup(this, parameterName, 'latest'),
    });

    new cdk.CfnOutput(this, 'AvailabilityZones', {
      value: vpc.availabilityZones.join(','),
    });
  }
}
