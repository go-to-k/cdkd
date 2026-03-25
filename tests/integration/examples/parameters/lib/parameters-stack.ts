import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * CloudFormation Parameters example stack
 *
 * Demonstrates:
 * - CfnParameter usage
 * - Parameter references with { Ref: 'ParameterName' }
 * - Default values for parameters
 * - Parameter types (String, Number, etc.)
 *
 * Note: cdkq needs to support Parameters section in templates
 * and resolve Ref to parameter values.
 */
export class ParametersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Define parameters
    const bucketPrefix = new cdk.CfnParameter(this, 'BucketPrefix', {
      type: 'String',
      default: 'cdkq-test',
      description: 'Prefix for the S3 bucket name',
      minLength: 3,
      maxLength: 20,
    });

    const enableVersioning = new cdk.CfnParameter(this, 'EnableVersioning', {
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
      description: 'Enable S3 bucket versioning',
    });

    // Use CfnBucket to access raw CloudFormation properties
    const bucket = new cdk.aws_s3.CfnBucket(this, 'ParameterizedBucket', {
      bucketName: `${bucketPrefix.valueAsString}-bucket`,
      versioningConfiguration: {
        status: enableVersioning.valueAsString === 'true' ? 'Enabled' : 'Suspended',
      },
      tags: [
        {
          key: 'Prefix',
          value: bucketPrefix.valueAsString,
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.ref,
      description: 'Created bucket name',
    });

    new cdk.CfnOutput(this, 'UsedPrefix', {
      value: bucketPrefix.valueAsString,
      description: 'Bucket prefix used',
    });
  }
}
