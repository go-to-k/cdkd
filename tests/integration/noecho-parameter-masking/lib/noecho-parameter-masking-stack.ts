import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * A `NoEcho: true` template PARAMETER consumed by resources (issue #1998).
 *
 * cdkd records such a value as a LOG-ONLY needle when a `Ref` or `Fn::Sub`
 * variable serves it: the provider's masker, the engine's error text and the
 * `deployments/*.jsonl` event mask it, while what cdkd PERSISTS is unchanged.
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
 *
 * covers: AWS::SSM::Parameter
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
