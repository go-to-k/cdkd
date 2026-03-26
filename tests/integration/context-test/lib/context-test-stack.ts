import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export class ContextTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Read context values
    const env = this.node.tryGetContext('env') || 'default';
    const featureFlag = this.node.tryGetContext('featureFlag') === 'true';

    // Use context in resource configuration
    const bucket = new s3.Bucket(this, 'ContextBucket', {
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
