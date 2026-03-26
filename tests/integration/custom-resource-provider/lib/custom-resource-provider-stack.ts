import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';

/**
 * Custom Resource Provider example stack
 *
 * Demonstrates:
 * - CDK Provider framework with isCompleteHandler (async pattern)
 * - Step Functions state machine orchestration
 * - S3 pre-signed URL for cfn-response (long-lived, 2 hour expiry)
 * - Async pattern detection and long polling timeout
 * - onEventHandler returns IsComplete: false to trigger async flow
 * - isCompleteHandler returns IsComplete: true to complete the operation
 */
export class CustomResourceProviderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // onEventHandler: starts the async operation
    // Returns IsComplete: false on Create/Update to trigger the isComplete polling
    // Returns IsComplete: true on Delete to complete immediately
    const onEventHandler = new lambda.Function(this, 'OnEvent', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    request_type = event.get('RequestType', '')
    print(f"OnEvent: {request_type}")
    if request_type == 'Delete':
        return {'IsComplete': True}
    return {
        'IsComplete': False,
        'Data': {'Message': 'Processing started'}
    }
`),
      timeout: cdk.Duration.seconds(30),
    });

    // isCompleteHandler: checks if the async operation is done
    // Always returns IsComplete: true with result data
    const isCompleteHandler = new lambda.Function(this, 'IsComplete', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    print(f"IsComplete check")
    return {
        'IsComplete': True,
        'Data': {'Result': 'Async operation completed!'}
    }
`),
      timeout: cdk.Duration.seconds(30),
    });

    // Provider construct: orchestrates onEvent and isComplete via Step Functions
    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler,
      isCompleteHandler,
    });

    // Custom resource using the async Provider
    const resource = new cdk.CustomResource(this, 'AsyncResource', {
      serviceToken: provider.serviceToken,
      properties: {
        Timestamp: Date.now().toString(),
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'ResourceResult', {
      value: resource.getAttString('Result'),
      description: 'Result from the async custom resource',
    });
  }
}
