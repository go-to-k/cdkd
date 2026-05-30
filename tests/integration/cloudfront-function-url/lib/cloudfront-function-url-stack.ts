import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

/**
 * CloudFront + Lambda Function URL example stack
 *
 * Demonstrates:
 * - Lambda function with inline Python code
 * - Lambda Function URL (public access, no IAM auth)
 * - CloudFront Distribution with Function URL as HTTP origin
 * - Lambda Permission for CloudFront
 * - Cross-resource references (Function URL → CloudFront origin)
 */
export class CloudFrontFunctionUrlStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Lambda function with inline Python code
    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromInline(`
def handler(event, context):
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json"
        },
        "body": '{"message": "Hello from Lambda Function URL behind CloudFront!"}'
    }
`),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(10),
    });

    // Add Function URL with public access (no IAM auth)
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // Exercise the issue #609 backfill of
    // `AWS::Lambda::Permission.InvokedViaFunctionUrl`. CDK's
    // `addFunctionUrl` does not set this flag on its auto-synthesized
    // permission, so an explicit `CfnPermission` is added to ensure the
    // flag reaches AWS via cdkd's provider. AWS requires
    // `Action = 'lambda:InvokeFunction'` when `InvokedViaFunctionUrl` is
    // set (the flag adds a Condition that restricts that action to
    // Function URL invocations). AWS reflects the flag by injecting a
    // `lambda:FunctionUrlAuthType` condition on the resource policy
    // statement — the verify.sh asserts that condition is present.
    new lambda.CfnPermission(this, 'ExplicitFnUrlPermission', {
      action: 'lambda:InvokeFunction',
      principal: '*',
      functionName: fn.functionName,
      functionUrlAuthType: 'NONE',
      invokedViaFunctionUrl: true,
    });

    // Create CloudFront Distribution with Function URL as origin
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(fnUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Distribution domain name',
    });

    new cdk.CfnOutput(this, 'FunctionUrl', {
      value: fnUrl.url,
      description: 'Lambda Function URL',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });
  }
}
