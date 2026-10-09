import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * go-to-k/cdkd#4749: a custom resource whose `ServiceToken` changes must be
 * refused, as CloudFormation refuses it, before either handler is invoked.
 *
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::Lambda::Function
 *
 * Two handlers, `HandlerA` and `HandlerB`, both ALWAYS present. Each writes an
 * SSM marker `/cdkd-integ/<stack>/<function name>/<RequestType>` on every
 * request it receives, so verify.sh can read back which handler got which
 * request. The markers are not stack resources: verify.sh sweeps them.
 *
 * Modes (`CDKD_TEST_UPDATE`, comma-separated), none adding or removing a
 * resource:
 *   - `switch-token`: `Cr` points at HandlerB instead of HandlerA. Refused at
 *     plan time.
 *   - `rename-a`: HandlerA's `FunctionName` changes, so it is REPLACED and its
 *     ARN moves. Refused once `Cr`'s token resolves, then rolled back.
 */
export class CrServiceTokenChangeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');
    const markerRoot = `/cdkd-integ/${this.stackName}`;

    const handler = (logicalId: string, functionName: string): lambda.Function => {
      const fn = new lambda.Function(this, logicalId, {
        functionName,
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(30),
        environment: { MARKER_ROOT: markerRoot },
        code: lambda.Code.fromInline(`
const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');
const ssm = new SSMClient({});
exports.handler = async (event, context) => {
  const name = process.env.MARKER_ROOT + '/' + context.functionName + '/' + event.RequestType;
  await ssm.send(new PutParameterCommand({
    Name: name, Value: event.RequestType, Type: 'String', Overwrite: true,
  }));
  return {
    Status: 'SUCCESS',
    PhysicalResourceId: event.PhysicalResourceId || 'cdkd-token-change-' + context.functionName,
    Data: {},
  };
};
`),
      });
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:PutParameter'],
          resources: [
            `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${markerRoot}/*`,
          ],
        })
      );
      return fn;
    };

    const handlerA = handler(
      'HandlerA',
      modes.includes('rename-a') ? `${this.stackName}-handler-a-renamed` : `${this.stackName}-handler-a`
    );
    const handlerB = handler('HandlerB', `${this.stackName}-handler-b`);

    new cdk.CustomResource(this, 'Cr', {
      serviceToken: modes.includes('switch-token') ? handlerB.functionArn : handlerA.functionArn,
      resourceType: 'Custom::CdkdTokenChange',
      properties: { Marker: 'v1' },
    });
  }
}
