import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';

/**
 * Regression test for the Pending-Lambda race fixed in
 * `LambdaFunctionProvider.create()` (waitUntilFunctionActiveV2).
 *
 * Repro setup:
 *  - VPC with one isolated subnet (no NAT / IGW; cheap and fast).
 *  - S3 Gateway VPC endpoint so the Lambda can PUT to the cfn-response
 *    pre-signed S3 URL without internet egress.
 *  - VPC-attached Lambda (`HandlerFn`) — VPC attachment is what makes
 *    the post-CreateFunction Active transition reliably slow (ENI
 *    attachment takes seconds, not milliseconds), guaranteeing the
 *    Lambda is in `Pending` state when cdkd dispatches the dependent
 *    Custom Resource Invoke.
 *  - `cdk.CustomResource` whose serviceToken === HandlerFn.functionArn
 *    — establishes the explicit dependency edge that pre-fix raced and
 *    post-fix correctly serializes.
 *
 * Pre-fix outcome: deploy fails on the Custom Resource with
 *   "The function is currently in the following state: Pending"
 * (or, less commonly with non-VPC handlers, succeeds by luck).
 *
 * Post-fix outcome: deploy succeeds; destroy succeeds (the existing
 * pre-delete VPC detach + ENI cleanup paths handle teardown).
 *
 * Second arm (`NotifyFn` + `NotifyBucket`): the same race through a different
 * consumer. A second VPC-attached Lambda is the DESTINATION of an S3 event
 * notification, which CDK synthesizes into a `Custom::S3BucketNotifications`
 * custom resource whose handler calls `PutBucketNotificationConfiguration`.
 * S3 validates the destination, and rejects it while it is still `Pending`
 * ("Unable to validate the following destination configurations"). The custom
 * resource's OWN backing function is a plain Lambda that is already Active, so
 * the backing-function wait never covers this one: only a wait on the function
 * the properties point at does.
 *
 * Pre-fix outcome: deploy fails on the notification resource and rolls back.
 * Post-fix outcome: deploy succeeds.
 *
 * covers: Custom::S3BucketNotifications
 */
export class VpcLambdaCrRaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      // Gateway endpoint is free and gives the VPC-attached Lambda a
      // path to S3 (cfn-response pre-signed URL target) without an IGW
      // or NAT.
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    const sg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'CR handler Lambda SG (egress only)',
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, 'HandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole'
        ),
      ],
    });

    // Minimal cfn-response Custom Resource handler. Uses urllib (stdlib)
    // so no Lambda Layer / extra deps are needed. PUTs SUCCESS to the
    // pre-signed S3 ResponseURL cdkd hands it.
    const handlerCode = `
import json
import urllib.request

def handler(event, context):
    print('Event: ' + json.dumps(event))
    body = {
        'Status': 'SUCCESS',
        'PhysicalResourceId': event.get('PhysicalResourceId') or 'vpc-lambda-cr-race-' + event['LogicalResourceId'],
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': {'Message': 'ok'},
    }
    req = urllib.request.Request(
        event['ResponseURL'],
        data=json.dumps(body).encode('utf-8'),
        method='PUT',
        headers={'Content-Type': ''},
    )
    with urllib.request.urlopen(req) as resp:
        print('Response status: ' + str(resp.status))
    return body
`;

    const handlerFn = new lambda.Function(this, 'HandlerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(handlerCode),
      role,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      timeout: cdk.Duration.seconds(30),
    });

    // The Custom Resource's serviceToken IS the VPC-attached Lambda's
    // ARN. cdkd's deploy engine therefore queues the CR's Invoke as
    // soon as HandlerFn is marked `created` — exactly the race the fix
    // closes.
    new cdk.CustomResource(this, 'RaceProbe', {
      serviceToken: handlerFn.functionArn,
      properties: {
        // No properties needed; just exercising the Invoke path.
      },
    });

    // Second arm: a VPC-attached Lambda as an S3 notification destination.
    // The handler body is irrelevant (the notification never has to fire); the
    // VPC attachment is what keeps the function `Pending` while cdkd runs the
    // `Custom::S3BucketNotifications` handler.
    const notifyFn = new lambda.Function(this, 'NotifyFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => {};'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      timeout: cdk.Duration.seconds(30),
    });

    const notifyBucket = new s3.Bucket(this, 'NotifyBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    notifyBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(notifyFn),
      { suffix: 'manifest-files.json' }
    );

    new cdk.CfnOutput(this, 'HandlerArn', {
      value: handlerFn.functionArn,
      description: 'ARN of the VPC-attached CR handler Lambda',
    });
    new cdk.CfnOutput(this, 'NotifyBucketName', {
      value: notifyBucket.bucketName,
      description: 'Bucket whose notification targets the VPC-attached NotifyFn',
    });
  }
}
