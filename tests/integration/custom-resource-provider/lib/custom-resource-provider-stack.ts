import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
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

    // --- Issues #2054 / #1866: a custom resource that MANAGES something ------
    //
    // The async resource above manages nothing outside itself, so a refused
    // delete there leaves no observable orphan and the #2054 assertion would be
    // about a log line rather than about a surviving resource. This one owns an
    // SSM parameter, so "the handler said FAILED and cdkd kept the record" has
    // a live AWS object behind it that `verify.sh` reads back BY ITS REAL AWS
    // NAME.
    //
    // The parameter's VALUE is the `StackId` the handler received, which is the
    // only way to observe issue #1866 from outside cdkd: the synthetic StackId
    // is handler-visible input and appears in no cdkd output.
    const managedParameterName = `/cdkd-integ/cr-delete-refusal/${id}`;

    // The injection is a scalar PROPERTY of the handler, never the presence of
    // a resource — a mode-gated resource DISAPPEARS in every later step whose
    // mode list omits the token, and here that would delete the very thing the
    // refusal is supposed to leave behind.
    const refuseDelete = (process.env['CDKD_TEST_UPDATE'] ?? '').includes('cr-delete-fails');

    const refusalHandler = new lambda.Function(this, 'DeleteRefusalHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        PARAM_NAME: managedParameterName,
        // Always PRESENT, only its value changes, so no deploy ever removes it.
        REFUSE_DELETE: refuseDelete ? '1' : '0',
      },
      code: lambda.Code.fromInline(`
import os
import boto3

ssm = boto3.client('ssm')
PARAM_NAME = os.environ['PARAM_NAME']
REFUSE_DELETE = os.environ.get('REFUSE_DELETE', '0')


def handler(event, context):
    request_type = event.get('RequestType', '')
    physical_id = event.get('PhysicalResourceId') or PARAM_NAME
    # Issue #1866: record the StackId cdkd synthesized for this handler. It is
    # the ONLY handler-visible surface for that value.
    stack_id = event.get('StackId', '<absent>')
    print('DeleteRefusalHandler: request_type=' + request_type + ' refuse=' + REFUSE_DELETE)

    if request_type in ('Create', 'Update'):
        ssm.put_parameter(
            Name=PARAM_NAME, Value=stack_id, Type='String', Overwrite=True
        )
        return {
            'Status': 'SUCCESS',
            'PhysicalResourceId': PARAM_NAME,
            'Data': {'ObservedStackId': stack_id},
        }

    if request_type == 'Delete':
        if REFUSE_DELETE == '1':
            # Deliberately leave the parameter ALIVE and SAY SO. Before issue
            # #2054 cdkd recorded this exactly like a successful delete.
            #
            # The wording is chosen to match none of cdkd's transient-authz
            # signals, so the response is terminal on the first attempt rather
            # than re-invoking this handler.
            return {
                'Status': 'FAILED',
                'PhysicalResourceId': physical_id,
                'Reason': 'integ injection: the managed parameter was left in place on purpose',
            }
        try:
            ssm.delete_parameter(Name=PARAM_NAME)
        except ssm.exceptions.ParameterNotFound:
            pass
        return {'Status': 'SUCCESS', 'PhysicalResourceId': physical_id}

    return {'Status': 'SUCCESS', 'PhysicalResourceId': physical_id}
`),
    });

    refusalHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:GetParameter'],
        // `managedParameterName` already carries its leading slash, which is
        // also the ARN's resource separator.
        resources: [
          `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${managedParameterName}`,
        ],
      })
    );

    // A named `Custom::` type so `verify.sh` can find the state record by TYPE
    // rather than by a CDK-generated logical id.
    new cdk.CustomResource(this, 'DeleteRefusalResource', {
      serviceToken: refusalHandler.functionArn,
      resourceType: 'Custom::CdkdDeleteRefusal',
      properties: {
        // Deliberately CONSTANT: a changing property would make every later
        // deploy issue an UPDATE this arm has no use for.
        ManagedParameter: managedParameterName,
      },
    });

    // --- Issue #1866's own verification bar: CDK's autoDeleteObjects -------
    //
    // That issue asks for a check that CDK's own `autoDeleteObjects` /
    // log-retention handlers — the handler family known to read
    // `event.StackId` — still work against the REAL synthesized StackId rather
    // than the fabricated one. `autoDeleteObjects` is the canonical reader and
    // the cheap one, so it is the arm.
    //
    // It is a `Custom::S3AutoDeleteObjects` resource cdkd did not author,
    // backed by CDK's own singleton Lambda, and `verify.sh` puts an OBJECT in
    // the bucket before the destroy — a bucket AWS would otherwise refuse to
    // delete. So "the bucket is gone afterwards" is only true if that handler
    // ran and emptied it, which makes the assertion about the handler rather
    // than about the bucket.
    const autoDeleteBucket = new s3.Bucket(this, 'AutoDeleteBucket', {
      bucketName: `cdkd-integ-cr-autodelete-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'AutoDeleteBucketName', {
      value: autoDeleteBucket.bucketName,
      description: 'Bucket whose CDK autoDeleteObjects handler reads event.StackId',
    });

    new cdk.CfnOutput(this, 'ManagedParameterName', {
      value: managedParameterName,
      description: 'SSM parameter the delete-refusal custom resource manages',
    });

    // Outputs
    new cdk.CfnOutput(this, 'ResourceResult', {
      value: resource.getAttString('Result'),
      description: 'Result from the async custom resource',
    });
  }
}
