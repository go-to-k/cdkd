import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * `cdkd import` of resources a `NoEcho: true` template parameter feeds
 * (go-to-k/cdkd#4043, Phase C). `verify.sh` generates the values per run and
 * passes them in as the parameters' `Default`s, which both `cdk deploy` and
 * `cdkd import` bind (neither is given `--parameters`).
 *
 * - `NoEchoConsumer`: an SSM String parameter whose value embeds the token
 *   through `Fn::Sub`, so the import resolves it through the value arm too.
 * - `NoEchoShortConsumer`: an SSM String parameter whose value IS a
 *   3-character `NoEcho` value, under the value arm's floor: only the
 *   positional arm masks it.
 * - `PlainConsumer`: an ordinary parameter beside them, the negative control.
 *
 * covers: AWS::SSM::Parameter
 */
export class ImportNoEchoParameterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const account = cdk.Stack.of(this).account;

    new cdk.CfnParameter(this, 'NoEchoToken', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_IMPORT_NOECHO_TOKEN'] ?? 'cdkd-import-noecho-unset',
    });
    new cdk.CfnParameter(this, 'NoEchoShort', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_IMPORT_NOECHO_SHORT'] ?? 'qzz',
    });

    new ssm.CfnParameter(this, 'NoEchoConsumer', {
      name: `cdkd-test-import-noecho-${account}`,
      type: 'String',
      value: cdk.Fn.sub('token-${NoEchoToken}'),
    });
    new ssm.CfnParameter(this, 'NoEchoShortConsumer', {
      name: `cdkd-test-import-noecho-short-${account}`,
      type: 'String',
      value: cdk.Fn.ref('NoEchoShort'),
    });
    new ssm.CfnParameter(this, 'PlainConsumer', {
      name: `cdkd-test-import-noecho-plain-${account}`,
      type: 'String',
      value: 'plain-control-value',
    });
  }
}
