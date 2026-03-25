import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * CloudFormation Conditions example stack
 *
 * This example demonstrates how to use CloudFormation Conditions with cdkq.
 * It shows:
 * - CfnParameter for user input
 * - CfnCondition with Fn::Equals
 * - Conditional resource creation with Fn::If
 * - Conditional properties based on conditions
 */
export class ConditionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a parameter to determine the environment
    const environmentParam = new cdk.CfnParameter(this, 'Environment', {
      type: 'String',
      default: 'Development',
      allowedValues: ['Development', 'Production'],
      description: 'Environment type for the stack',
    });

    // Create a parameter for bucket versioning
    const enableVersioningParam = new cdk.CfnParameter(this, 'EnableVersioning', {
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
      description: 'Enable versioning for S3 buckets',
    });

    // Condition: Is this a production environment?
    const isProduction = new cdk.CfnCondition(this, 'IsProduction', {
      expression: cdk.Fn.conditionEquals(
        environmentParam.valueAsString,
        'Production'
      ),
    });

    // Condition: Should we enable versioning?
    const shouldEnableVersioning = new cdk.CfnCondition(this, 'ShouldEnableVersioning', {
      expression: cdk.Fn.conditionEquals(
        enableVersioningParam.valueAsString,
        'true'
      ),
    });

    // Condition: Production AND Versioning enabled
    const productionWithVersioning = new cdk.CfnCondition(this, 'ProductionWithVersioning', {
      expression: cdk.Fn.conditionAnd(isProduction, shouldEnableVersioning),
    });

    // Create a basic bucket (always created)
    const basicBucket = new s3.Bucket(this, 'BasicBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Add conditional tags based on environment
    cdk.Tags.of(basicBucket).add('Environment', environmentParam.valueAsString);
    cdk.Tags.of(basicBucket).add('Project', 'cdkq-conditions');

    // Create a production-only bucket using CfnBucket with conditions
    const prodBucket = new s3.CfnBucket(this, 'ProductionBucket', {
      bucketName: cdk.Fn.conditionIf(
        isProduction.logicalId,
        `cdkq-prod-bucket-${cdk.Aws.ACCOUNT_ID}`,
        cdk.Aws.NO_VALUE
      ).toString(),
      versioningConfiguration: cdk.Fn.conditionIf(
        shouldEnableVersioning.logicalId,
        {
          status: 'Enabled',
        },
        cdk.Aws.NO_VALUE
      ) as any,
      tags: [
        {
          key: 'Environment',
          value: 'Production',
        },
        {
          key: 'Critical',
          value: 'true',
        },
      ],
    });

    // Apply condition to the production bucket
    prodBucket.cfnOptions.condition = isProduction;

    // Create outputs with conditional values
    new cdk.CfnOutput(this, 'BasicBucketName', {
      value: basicBucket.bucketName,
      description: 'Name of the basic S3 bucket (always created)',
    });

    new cdk.CfnOutput(this, 'ProductionBucketName', {
      value: cdk.Fn.conditionIf(
        isProduction.logicalId,
        prodBucket.ref,
        'Not created (not production environment)'
      ).toString(),
      description: 'Name of the production S3 bucket (conditional)',
    });

    new cdk.CfnOutput(this, 'VersioningStatus', {
      value: cdk.Fn.conditionIf(
        shouldEnableVersioning.logicalId,
        'Enabled',
        'Disabled'
      ).toString(),
      description: 'Versioning status for buckets',
    });

    new cdk.CfnOutput(this, 'EnvironmentType', {
      value: environmentParam.valueAsString,
      description: 'Current environment type',
    });
  }
}
