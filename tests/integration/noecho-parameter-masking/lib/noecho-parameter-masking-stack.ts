import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * A `NoEcho: true` template PARAMETER consumed by resources (issue #1998).
 *
 * cdkd records such a value as a LOG-ONLY needle when a `Ref` or `Fn::Sub`
 * variable serves it: the provider's masker, the engine's error text and the
 * `deployments/*.jsonl` event mask it, while what cdkd PERSISTS is unchanged
 * except an export alias, which is refused (issue #4043).
 * `verify.sh` generates the value per run and passes it in through
 * `CDKD_TEST_NOECHO_TOKEN`, which becomes the parameter's `Default` (cdkd
 * deploy takes no `--parameters`).
 *
 * - `NoEchoConsumer`: an SSM String parameter whose value embeds the token
 *   through `Fn::Sub`, so the resolver's `--verbose` `Resolved Fn::Sub:` line
 *   carries it, and AWS and state.json hold it in the clear (the decision).
 * - `NoEchoReject` (only under `CDKD_TEST_NOECHO_REJECT=true`): an SSM
 *   parameter whose `Tier` IS the token. `PutParameter` rejects it with a
 *   service-side `ValidationException` that quotes the value back
 *   (`Value '<token>' at 'tier' failed to satisfy constraint`, measured), so
 *   the deploy fails through the provider's own error masking, the engine's
 *   error masking and the recorded event, the three surfaces the fix covers.
 *   An `AllowedPattern` rejection was the first vehicle and does NOT quote the
 *   value (`Parameter value, cannot be validated against allowedPattern`).
 * - `NoEchoRenamed` (go-to-k/cdkd#4049): an SNS topic whose create-only
 *   `TopicName` is a literal, and under `CDKD_TEST_NOECHO_RENAME=true` embeds
 *   the token, so that redeploy prints the diff's `--verbose`
 *   `requires replacement (<old> -> <new>)` line over it.
 * - `NoEchoAliasProbe` (go-to-k/cdkd#4043): the output's `Export.Name` IS a
 *   second `NoEcho` parameter (`CDKD_TEST_NOECHO_ALIAS_TOKEN`), so every
 *   deploy refuses the alias: it reaches neither state nor the exports index,
 *   and the warning names it masked.
 *
 * covers: AWS::SSM::Parameter, AWS::SNS::Topic
 */
export class NoechoParameterMaskingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = cdk.Stack.of(this).account;

    const token = new cdk.CfnParameter(this, 'NoEchoToken', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_TOKEN'] ?? 'cdkd-noecho-unset-token',
    });

    new ssm.CfnParameter(this, 'NoEchoConsumer', {
      name: `cdkd-test-noecho-consumer-${account}`,
      type: 'String',
      value: cdk.Fn.sub('token=${NoEchoToken}'),
    });

    new sns.CfnTopic(this, 'NoEchoRenamed', {
      topicName:
        process.env['CDKD_TEST_NOECHO_RENAME'] === 'true'
          ? cdk.Fn.sub('cdkd-test-noecho-rename-${AWS::AccountId}-${NoEchoToken}')
          : `cdkd-test-noecho-rename-${account}-a`,
    });

    const aliasToken = new cdk.CfnParameter(this, 'NoEchoAliasToken', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_ALIAS_TOKEN'] ?? 'CdkdNoEchoAliasUnset',
    });
    new cdk.CfnOutput(this, 'NoEchoAliasProbe', {
      value: 'alias-probe-value',
      exportName: aliasToken.valueAsString,
    });

    if (process.env['CDKD_TEST_NOECHO_REJECT'] === 'true') {
      new ssm.CfnParameter(this, 'NoEchoReject', {
        name: `cdkd-test-noecho-reject-${account}`,
        type: 'String',
        value: 'noecho-reject-probe',
        tier: token.valueAsString,
      });
    }
  }
}
