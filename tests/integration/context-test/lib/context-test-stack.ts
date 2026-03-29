import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export class ContextTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Read context values (required - must be provided via cdk.json or CLI -c)
    const env = this.node.tryGetContext('env') as string | undefined;
    if (!env) {
      throw new Error(
        "Context value 'env' is required. Set it in cdk.json or pass via -c env=<value>"
      );
    }

    const featureFlagStr = this.node.tryGetContext('featureFlag') as string | undefined;
    if (featureFlagStr === undefined) {
      throw new Error(
        "Context value 'featureFlag' is required. Set it in cdk.json or pass via -c featureFlag=<value>"
      );
    }
    const featureFlag = featureFlagStr === 'true';

    // Use context in resource configuration
    new s3.Bucket(this, 'ContextBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create SSM parameter with context value to verify it was passed
    new ssm.StringParameter(this, 'EnvParam', {
      parameterName: `/cdkd-test/context/${this.stackName}/env`,
      stringValue: env,
    });

    // Conditionally create resource based on context
    if (featureFlag) {
      new ssm.StringParameter(this, 'FeatureParam', {
        parameterName: `/cdkd-test/context/${this.stackName}/feature`,
        stringValue: 'enabled',
      });
    }

    new cdk.CfnOutput(this, 'Environment', { value: env });
    new cdk.CfnOutput(this, 'FeatureEnabled', { value: String(featureFlag) });

    cdk.Tags.of(this).add('Project', 'cdkd');
    cdk.Tags.of(this).add('Example', 'context-test');
  }
}
