import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Lambda Versioning example stack
 *
 * Demonstrates:
 * - AWS::Lambda::Function (inline Python code)
 * - AWS::Lambda::Version (CfnVersion)
 * - AWS::Lambda::Alias (CfnAlias)
 * - CfnOutputs for function name, version, alias ARN
 */
export class LambdaVersioningStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda function with inline code
    const fn = new lambda.Function(this, 'VersionedFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'def handler(event, context): return {"statusCode": 200}'
      ),
    });

    // Lambda Version
    const version = new lambda.CfnVersion(this, 'FnVersion', {
      functionName: fn.functionName,
    });

    // Lambda Alias pointing to the version
    const alias = new lambda.CfnAlias(this, 'FnAlias', {
      functionName: fn.functionName,
      functionVersion: version.attrVersion,
      name: 'live',
    });

    // Outputs
    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'VersionNumber', {
      value: version.attrVersion,
      description: 'Lambda version number',
    });

    new cdk.CfnOutput(this, 'AliasArn', {
      value: alias.ref,
      description: 'Lambda alias ARN',
    });
  }
}
