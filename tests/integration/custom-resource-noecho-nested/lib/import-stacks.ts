import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { crHandler, noEchoLayer, noEchoNonce, valueResource } from './shared.ts';

export const NOECHO_EXPORT_NAME = 'CdkdCrNoEchoNestedToken';
export const PLAIN_EXPORT_NAME = 'CdkdCrNoEchoNestedPlain';

/**
 * The PRODUCER of the `Fn::ImportValue` arm of issue #2460: a `NoEcho` custom
 * resource and an ordinary one, each EXPORTED.
 *
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::Lambda::Function
 * covers: AWS::Lambda::LayerVersion
 * covers: AWS::SSM::Parameter
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
    // it sees the new value without promotion (unlike the nested arm).
    const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    const noEchoCr = valueResource(this, 'ProducerNoEchoCr', handler, {
      prefix: 'noecho-producer-token',
      seed: modes.includes('producer-seed') ? 'updated' : 'integ',
      noEcho: true,
      nonce: noEchoNonce(),
    });
    const plainCr = valueResource(this, 'ProducerPlainCr', handler, {
      prefix: 'plain-producer-value',
      seed: 'integ',
      noEcho: false,
    });

    // A SAME-STACK reader of the NoEcho CR (go-to-k/cdkd#3662). The CR's
    // attributes are its handler's `Data`, never a template property, so only
    // the diff's custom-resource promotion reaches this parameter in phase 4,
    // and only the engine's mask-only exception sends it the new token.
    new ssm.StringParameter(this, 'ProducerNoEchoParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/producer/noecho',
      stringValue: noEchoCr.getAttString('Value'),
    });

    // A SAME-STACK create-only reader (go-to-k/cdkd#3729): replaced in phase 4,
    // where the token moves, and left alone in phase 7, where the CR re-runs
    // and returns the same token.
    noEchoLayer(
      this,
      'ProducerNoEchoLayer',
      'cdkd-integ-crnoecho-nested-producer-layer',
      noEchoCr.getAttString('Value')
    );

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

    // No own-property change in any phase (go-to-k/cdkd#3662): in phase 4 the
    // diff sees the new token through the recovery, and the engine must send
    // it although the record and the redacted value are both `***`.
    new ssm.StringParameter(this, 'NoEchoParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/consumer/noecho',
      stringValue: cdk.Fn.importValue(NOECHO_EXPORT_NAME),
    });
    new ssm.StringParameter(this, 'PlainParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/consumer/plain',
      stringValue: cdk.Fn.importValue(PLAIN_EXPORT_NAME),
    });
  }
}
