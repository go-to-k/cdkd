import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';

/**
 * go-to-k/cdkd#6117: a `cr.Provider`-backed custom resource whose handler
 * answers `PhysicalResourceId = Name`. When `Name` changes, the Update answers
 * a NEW id, and CloudFormation then sends the OLD id a `Delete` (with the old
 * properties) in the stack's cleanup phase.
 *
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::Lambda::Function
 *
 * The handler writes an SSM parameter `/cdkd-integ/<stack>/res/<physical id>`
 * on Create / Update and deletes it on Delete, recording each Delete as
 * `/cdkd-integ/<stack>/deleted/<physical id>` holding the `Name` its
 * `ResourceProperties` carried, so verify.sh reads back which id got a Delete
 * and with which properties. The parameters are not stack resources: verify.sh
 * sweeps them.
 *
 * `CDKD_TEST_UPDATE=true` changes `Name` from `<stack>-name-1` to
 * `<stack>-name-2`. `CDKD_TEST_UPDATE=fail` changes it to `<stack>-name-3`
 * and makes `Gate` (a second resource on the same handler, updated after
 * `Res`) fail its Update, so a `--no-rollback` deploy stops with the old id
 * left in state for `cdkd destroy`.
 */
export class CrPhysidReplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const root = `/cdkd-integ/${this.stackName}`;
    const onEvent = new lambda.Function(this, 'OnEvent', {
      functionName: `${this.stackName}-on-event`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      environment: { ROOT: root },
      code: lambda.Code.fromInline(`
const {
  SSMClient, PutParameterCommand, DeleteParameterCommand,
} = require('@aws-sdk/client-ssm');
const ssm = new SSMClient({});
exports.handler = async (event) => {
  const name = event.ResourceProperties.Name;
  if (event.ResourceProperties.Role === 'gate') {
    if (event.RequestType !== 'Delete' && event.ResourceProperties.Fail === 'yes') {
      throw new Error('cdkd-integ deliberate Gate failure');
    }
    return { PhysicalResourceId: 'gate' };
  }
  if (event.RequestType === 'Delete') {
    const id = event.PhysicalResourceId;
    try {
      await ssm.send(new DeleteParameterCommand({ Name: process.env.ROOT + '/res/' + id }));
    } catch (err) {
      if (err.name !== 'ParameterNotFound') throw err;
    }
    await ssm.send(new PutParameterCommand({
      Name: process.env.ROOT + '/deleted/' + id, Value: name, Type: 'String', Overwrite: true,
    }));
    return { PhysicalResourceId: id };
  }
  await ssm.send(new PutParameterCommand({
    Name: process.env.ROOT + '/res/' + name, Value: name, Type: 'String', Overwrite: true,
  }));
  return { PhysicalResourceId: name, Data: { Name: name } };
};
`),
    });
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${root}/*`],
      })
    );

    const provider = new cr.Provider(this, 'Provider', { onEventHandler: onEvent });
    const mode = process.env.CDKD_TEST_UPDATE;
    const version = mode === 'true' ? 2 : mode === 'fail' ? 3 : 1;
    const res = new cdk.CustomResource(this, 'Res', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CdkdPhysidReplace',
      properties: { Name: `${this.stackName}-name-${version}` },
    });
    const gate = new cdk.CustomResource(this, 'Gate', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::CdkdPhysidGate',
      properties: { Role: 'gate', Fail: mode === 'fail' ? 'yes' : 'no' },
    });
    gate.node.addDependency(res);
  }
}
