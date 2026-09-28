import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Failure-seeking integ for go-to-k/cdkd#3938: a custom resource whose
 * RECORDED `ServiceToken` is the redaction mask `***`.
 *
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::Lambda::Function
 *
 * Shape under test (one handler, two custom resources on it):
 *
 *   EchoProducer    (handler answers `NoEcho: true` and echoes its own
 *                    `ServiceToken` into `Data.ServiceTokenEcho`)
 *      |
 *      +--> MaskedDependent  (SAME handler; property `Upstream` =
 *                             Fn::GetAtt(EchoProducer, 'ServiceTokenEcho'))
 *
 * `Upstream` resolves to a `NoEcho` value, so it becomes a MASK-ONLY redaction
 * needle in the dependent's record (issue #2274). That needle is the handler's
 * ARN, which is also the dependent's own `ServiceToken`, so the whole-leaf
 * redaction rewrites `properties.ServiceToken` to `***` too. The producer's own
 * record is protected by its `excluded` set and keeps the real ARN — the
 * in-fixture negative control.
 *
 * `MaskedDependent` exists only while `CDKD_TEST_UPDATE` names
 * `masked-dependent`: verify.sh deploys it for the skip phase and leaves it out
 * of the final clean deploy / destroy, which is the one the `integ-destroy`
 * gate reads. The stack is re-created fresh for that phase, so dropping the
 * resource there is a fresh template, not a removal.
 */
export class CrMaskedServiceTokenStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const withDependent = (process.env.CDKD_TEST_UPDATE ?? '')
      .split(',')
      .includes('masked-dependent');

    // SIMPLE-HANDLER response shape (no `Status`): the shape cdkd re-synthesizes
    // an envelope for, and must copy `NoEcho` across explicitly.
    const handler = new lambda.Function(this, 'EchoHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  console.log('CR event:', JSON.stringify(event));
  const props = event.ResourceProperties || {};
  if (event.RequestType === 'Delete') {
    return {
      Status: 'SUCCESS',
      PhysicalResourceId: event.PhysicalResourceId || 'cr-masked-token',
    };
  }
  if (props.Role === 'producer') {
    return {
      PhysicalResourceId: 'cr-masked-token-producer',
      Data: { ServiceTokenEcho: props.ServiceToken },
      NoEcho: true,
    };
  }
  return { PhysicalResourceId: 'cr-masked-token-dependent', Data: {} };
};
`),
    });

    const producer = new cdk.CustomResource(this, 'EchoProducer', {
      serviceToken: handler.functionArn,
      resourceType: 'Custom::CdkdMaskedTokenProducer',
      properties: { Role: 'producer' },
    });

    if (withDependent) {
      new cdk.CustomResource(this, 'MaskedDependent', {
        serviceToken: handler.functionArn,
        resourceType: 'Custom::CdkdMaskedTokenDependent',
        properties: {
          Role: 'dependent',
          Upstream: producer.getAttString('ServiceTokenEcho'),
        },
      });
    }
  }
}
