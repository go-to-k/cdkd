import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Fixture for go-to-k/cdkd#6894: a deploy that is force-quit (a second
 * SIGINT) or hung up (SIGHUP) while an operation is in flight must leave a
 * rollback journal, so `cdkd rollback` can revert what it already changed.
 *
 * `FIXTURE_VERSION` (`v1` by default, `v2` for the interrupted deploy) changes
 * every resource's properties, so a v2 deploy UPDATEs all of them:
 *
 *   1. `Marker` (SSM parameter value), `Queue` (visibility timeout) and `Fn`
 *      (an environment variable) update first and quickly.
 *   2. `Gate`, a Lambda-backed custom resource reading all three, updates
 *      next; its handler sleeps 90 s on `Update` before it answers, which is
 *      the window verify.sh interrupts in.
 *   3. `After` (SSM parameter) and `AfterQueue` depend on `Gate`, so an
 *      interrupted deploy never reaches them.
 *
 * The handler PUTs its own response to `ResponseURL` (no `cfn-response`
 * module, so the inline code needs no bundling). Every function is
 * auto-named, so its log group falls under the shared
 * `/aws/lambda/<stack>-` sweep.
 */
const GATE_HANDLER = `
const https = require('https');
exports.handler = async (event) => {
  if (event.RequestType === 'Update') {
    // verify.sh waits for this line before it interrupts the deploy.
    console.log('GATE_UPDATE_START');
    await new Promise((resolve) => setTimeout(resolve, 90000));
  }
  const body = JSON.stringify({
    Status: 'SUCCESS',
    Reason: 'ok',
    PhysicalResourceId: event.PhysicalResourceId || 'force-quit-gate',
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: {},
  });
  const url = new URL(event.ResponseURL);
  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: { 'content-type': '', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
};
`;

export class DeployForceQuitRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'deploy-force-quit-rollback');

    const version = process.env.FIXTURE_VERSION === 'v2' ? 'v2' : 'v1';
    const isV2 = version === 'v2';

    const marker = new ssm.StringParameter(this, 'Marker', {
      parameterName: `${this.stackName}-marker`,
      stringValue: `marker-${version}`,
    });

    const queue = new sqs.Queue(this, 'Queue', {
      queueName: `${this.stackName}-queue`,
      visibilityTimeout: cdk.Duration.seconds(isV2 ? 45 : 30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      environment: { FIXTURE_MARKER: `fn-${version}` },
    });

    const gateHandler = new lambda.Function(this, 'GateHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(GATE_HANDLER),
      timeout: cdk.Duration.seconds(150),
    });

    const gate = new cdk.CustomResource(this, 'Gate', {
      serviceToken: gateHandler.functionArn,
      properties: {
        Version: version,
        MarkerName: marker.parameterName,
        QueueUrl: queue.queueUrl,
        FunctionName: fn.functionName,
      },
    });
    gate.node.addDependency(marker, queue, fn);

    const after = new ssm.StringParameter(this, 'After', {
      parameterName: `${this.stackName}-after`,
      stringValue: `after-${version}`,
    });
    after.node.addDependency(gate);

    const afterQueue = new sqs.Queue(this, 'AfterQueue', {
      queueName: `${this.stackName}-after-queue`,
      visibilityTimeout: cdk.Duration.seconds(isV2 ? 60 : 30),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    afterQueue.node.addDependency(gate);
  }
}
