import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { crHandler, valueResource } from './shared.ts';

export const NOECHO_EXPORT_NAME = 'CdkdCrNoEchoNestedToken';
export const PLAIN_EXPORT_NAME = 'CdkdCrNoEchoNestedPlain';

/**
 * The PRODUCER of the `Fn::ImportValue` arm of issue #2460: a `NoEcho` custom
 * resource and an ordinary one, each EXPORTED.
 *
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::Lambda::Function
 *
 * Its persisted `state.outputs` and the shared exports index hold `***` for
 * the sensitive export (issue #2274); the consumer deployed in the SAME
 * `cdkd deploy --all` gets the plaintext back from the in-run recovery store.
 */
export class ImportProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const handler = crHandler(this, 'ProducerCrHandler', 'cdkd-integ-crnoecho-nested-producer');
    // verify.sh's phase 4 flips this Seed (`producer-seed`), so the export
    // value changes and the consumer takes an UPDATE: the recovery then runs in
    // the consumer's DIFF and its provisioning, not only on a CREATE. The
    // consumer's diff runs after the producer deploys under `deploy --all`, so
    // it sees the new value without promotion (unlike the nested arm); its
    // own-property change is for go-to-k/cdkd#3662, below.
    const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    const noEchoCr = valueResource(this, 'ProducerNoEchoCr', handler, {
      prefix: 'noecho-producer-token',
      seed: modes.includes('producer-seed') ? 'updated' : 'integ',
      noEcho: true,
    });
    const plainCr = valueResource(this, 'ProducerPlainCr', handler, {
      prefix: 'plain-producer-value',
      seed: 'integ',
      noEcho: false,
    });

    new cdk.CfnOutput(this, 'NoEchoTokenExport', {
      value: noEchoCr.getAttString('Value'),
      exportName: NOECHO_EXPORT_NAME,
    }).overrideLogicalId('NoEchoTokenExport');
    new cdk.CfnOutput(this, 'PlainValueExport', {
      value: plainCr.getAttString('Value'),
      exportName: PLAIN_EXPORT_NAME,
    }).overrideLogicalId('PlainValueExport');
  }
}

/**
 * The CONSUMER of the `Fn::ImportValue` arm: two SSM parameters importing the
 * producer's exports. `NoEchoParam` must hold the REAL token on AWS and `***`
 * in cdkd state; `PlainParam` is the negative control and stays in the clear.
 *
 * covers: AWS::SSM::Parameter
 */
export class ImportConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    new ssm.StringParameter(this, 'NoEchoParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/consumer/noecho',
      stringValue: cdk.Fn.importValue(NOECHO_EXPORT_NAME),
      // An OWN-property change on the same token as the producer's Seed. The
      // consumer's diff DOES see the new value (the recovery serves it), but
      // the engine's post-resolution skip compares the REDACTED bag with the
      // record, i.e. `***` with `***`, and skips the update
      // (go-to-k/cdkd#3662). This makes the bags differ so the update is sent;
      // drop it once #3662 lands and phase 4 must still pass.
      description: modes.includes('producer-seed')
        ? 'cdkd integ custom-resource-noecho-nested - phase 4'
        : 'cdkd integ custom-resource-noecho-nested - phase 1',
    });
    new ssm.StringParameter(this, 'PlainParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/consumer/plain',
      stringValue: cdk.Fn.importValue(PLAIN_EXPORT_NAME),
    });
  }
}
