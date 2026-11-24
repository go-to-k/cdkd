import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * go-to-k/cdkd#6940 rule (2): under `cdkd deploy --no-wait`, a custom
 * resource waits, before its handler is invoked, for every skipped-wait
 * resource upstream of it and of its handler function.
 *
 * The handler runs in a private subnet whose only way out is the default route
 * to a NAT gateway. CDK expresses that only through the route: the function
 * depends on the subnet's default route, the route references the gateway,
 * and nothing references the gateway's readiness. On Create the handler fetches
 * https://checkip.amazonaws.com and answers FAILED when it cannot.
 *
 * Under `--no-wait` the NAT gateway's create returns while it is `pending`
 * (about 90 s to `available`), and a pending gateway forwards no traffic.
 * Before #6940 nothing between the gateway's create and the handler's invoke
 * waited for it — only the route create and the function's own `Active` wait,
 * a few seconds for a VPC function — so the handler's call timed out and the
 * deploy failed. With #6940 the invoke waits for the gateway to be
 * `available`, and the handler answers with the gateway's public IP.
 *
 * The response goes to the state bucket through an S3 gateway endpoint, so
 * only the handler's own call depends on the NAT gateway.
 *
 * covers: AWS::EC2::NatGateway
 */
export class NoWaitCrNatEgressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${this.stackName}-vpc`,
      maxAzs: 1,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    const sg = new ec2.SecurityGroup(this, 'ProbeSg', {
      vpc,
      description: 'Egress-only security group of the probe handler',
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, 'ProbeRole', {
      roleName: `${this.stackName}-probe`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    const handlerCode = `
const https = require('https');

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out after ' + options.timeout + ' ms')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const physicalId = event.PhysicalResourceId || 'nat-egress-probe';
  let status = 'SUCCESS';
  let reason;
  let data = {};
  if (event.RequestType !== 'Delete') {
    try {
      const res = await request('https://checkip.amazonaws.com/', { method: 'GET', timeout: 10000 });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      data = { Ip: res.text.trim() };
    } catch (error) {
      status = 'FAILED';
      reason = 'egress through the NAT gateway failed: ' + error.message;
    }
  }
  const body = JSON.stringify({
    Status: status,
    Reason: reason,
    PhysicalResourceId: physicalId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });
  await request(event.ResponseURL, {
    method: 'PUT',
    timeout: 10000,
    headers: { 'Content-Type': '', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  return JSON.parse(body);
};
`;

    const handler = new lambda.Function(this, 'ProbeHandler', {
      functionName: `${this.stackName}-probe`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(handlerCode),
      role,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      timeout: cdk.Duration.seconds(30),
    });

    const probe = new cdk.CustomResource(this, 'Probe', {
      serviceToken: handler.functionArn,
    });

    new cdk.CfnOutput(this, 'ProbeIp', { value: probe.getAttString('Ip') });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
  }
}
