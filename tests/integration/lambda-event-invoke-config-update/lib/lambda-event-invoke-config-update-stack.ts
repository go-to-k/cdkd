import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';

/**
 * Integ probe for the Lambda EventInvokeConfig UPDATE path.
 *
 * An async Lambda with an `onFailure` destination + `maxEventAge` +
 * `retryAttempts` synthesizes an AWS::Lambda::EventInvokeConfig. Before the
 * fix this type had no SDK provider, so it routed through Cloud Control —
 * whose JSON-patch read-modify-write UPDATE picks up the AWS-injected empty
 * `DestinationConfig.OnSuccess: {}` from the read handler and hard-fails model
 * validation (`#/DestinationConfig/OnSuccess: required key [Destination] not
 * found`) on every change to `maxEventAge` / `retryAttempts`. The fix adds an
 * SDK provider whose create/update both call PutFunctionEventInvokeConfig (a
 * full-replace write, exactly what CloudFormation uses), sending only the
 * configured `OnFailure` and never an empty `OnSuccess`.
 *
 * Phase 1 (no env): maxEventAge 2 min, retryAttempts 1, onFailure -> DLQ.
 * Phase 2 (CDKD_TEST_UPDATE=true): maxEventAge 5 min, retryAttempts 2 (same
 * DLQ). This is the exact change that was undeployable pre-fix.
 *
 * Fixed physical FunctionName / DLQ name so verify.sh can assert the
 * async-invoke config reached AWS with the expected values.
 */
export class LambdaEventInvokeConfigUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const dlq = new sqs.Queue(this, 'Dlq', {
      queueName: 'cdkd-event-invoke-config-update-test-dlq',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-event-invoke-config-update-test-fn',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200, body: "ok" });'
      ),
      // The async-invoke config -> AWS::Lambda::EventInvokeConfig.
      maxEventAge: cdk.Duration.minutes(isUpdate ? 5 : 2),
      retryAttempts: isUpdate ? 2 : 1,
      onFailure: new destinations.SqsDestination(dlq),
    });

    const eic = fn.node.findChild('EventInvokeConfig').node
      .defaultChild as lambda.CfnEventInvokeConfig;

    // Issue #4118: CDKD_TEST_FN_ARN=true re-spells the SAME function as its
    // ARN. That must stay an in-place update; a replacement would Put the
    // config and then delete it from the same function.
    if (process.env.CDKD_TEST_FN_ARN === 'true') {
      eic.addPropertyOverride('FunctionName', fn.functionArn);
    }

    // Issue #4134: CDKD_TEST_FN_VIA_CR=name|arn adds a custom resource whose
    // Data returns the function's name or ARN; CDKD_TEST_FN_WIRE=true feeds
    // FunctionName from it. Flipping name -> arn updates the CR in place, which
    // the diff propagates to the config as a replacement CEILING; the moved
    // value is the same function, so the engine must lower it to in place.
    const fnViaCr = process.env.CDKD_TEST_FN_VIA_CR;
    if (fnViaCr !== undefined && fnViaCr !== '') {
      const handler = new lambda.Function(this, 'FnSpellHandler', {
        functionName: 'cdkd-event-invoke-config-update-test-cr',
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(30),
        code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const props = event.ResourceProperties || {};
  if (event.RequestType === 'Delete') {
    return { Status: 'SUCCESS', PhysicalResourceId: event.PhysicalResourceId || 'fn-spell' };
  }
  return {
    PhysicalResourceId: 'fn-spell',
    Data: { Fn: props.Spell === 'arn' ? props.FnArn : props.FnName },
  };
};
`),
      });
      const spell = new cdk.CustomResource(this, 'FnSpell', {
        serviceToken: handler.functionArn,
        properties: { FnName: fn.functionName, FnArn: fn.functionArn, Spell: fnViaCr },
      });
      if (process.env.CDKD_TEST_FN_WIRE === 'true') {
        eic.addPropertyOverride('FunctionName', spell.getAttString('Fn'));
      }
    }

    new cdk.CfnOutput(this, 'FnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'DlqArn', { value: dlq.queueArn });
  }
}
