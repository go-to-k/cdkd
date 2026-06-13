import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integration fixture for the graceful-SIGINT destroy path (issue #816)
 * and the Custom-Resource replay-after-partial-failure fail-fast (issue
 * #804).
 *
 * Resource set, chosen so a destroy takes several seconds (long enough for
 * a mid-destroy SIGINT to land during deletion) AND so it exercises the CR
 * + backing-Lambda teardown order the #804 fix depends on:
 *
 *  - VPC with TWO isolated subnets (no NAT / IGW; cheap + fast to create,
 *    but VPC + subnets + the SecurityGroup + the Lambda hyperplane ENI all
 *    have to delete in order, which is what makes the destroy span several
 *    seconds rather than completing instantly).
 *  - S3 Gateway VPC endpoint so the VPC-attached Lambda can PUT to the
 *    cfn-response pre-signed S3 URL without internet egress.
 *  - A VPC-attached Lambda (`HandlerFn`) backing a `cdk.CustomResource`
 *    (`CrProbe`). On a re-run after a first interrupted destroy, the
 *    backing Lambda may already be gone — replaying the CR delete used to
 *    stall 10 minutes waiting on `GetFunction` against the deleted
 *    function (the #804 bug). The #804 fail-fast + incremental destroy
 *    persistence make the re-run resolve quickly.
 *  - A handful of `AWS::SSM::Parameter` resources — extra independent
 *    resources that pad the delete loop so a SIGINT reliably lands while
 *    deletion is in flight, and confirm partial-destroy state preservation
 *    (some may remain after the first interrupted run, all gone after the
 *    re-run).
 *
 * Everything uses `RemovalPolicy.DESTROY` semantics by default; the stack
 * is fully destroyable with no retained resources.
 */
export class DestroyInterruptStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      // Gateway endpoint is free and gives the VPC-attached Lambda a path
      // to S3 (cfn-response pre-signed URL target) with no IGW or NAT.
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
        'PhysicalResourceId': event.get('PhysicalResourceId') or 'destroy-interrupt-' + event['LogicalResourceId'],
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

    // Custom Resource backed by the VPC-attached Lambda. On a destroy
    // re-run after the first run already deleted the backing Lambda, the
    // CR delete must NOT stall waiting on the gone function (issue #804).
    new cdk.CustomResource(this, 'CrProbe', {
      serviceToken: handlerFn.functionArn,
      properties: {
        // No properties needed; just exercising the delete path.
      },
    });

    // Several independent SSM parameters pad the delete loop so a SIGINT
    // reliably lands while deletion is in flight, and let us assert that a
    // first interrupted destroy preserves (not deletes) state for the
    // not-yet-deleted resources.
    for (let i = 0; i < 4; i++) {
      new ssm.StringParameter(this, `Param${i}`, {
        stringValue: `destroy-interrupt-value-${i}`,
      });
    }

    new cdk.CfnOutput(this, 'HandlerArn', {
      value: handlerFn.functionArn,
      description: 'ARN of the VPC-attached CR handler Lambda',
    });
  }
}
