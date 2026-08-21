import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  CONDITIONAL_EXPORT_NAME,
  CONDITIONAL_PLAIN_VALUE,
  EXPORT_NAME,
  SECRET_JSON_FIELD,
  SECRET_NAME,
  integSecretPlaintext,
} from './shared.ts';

/**
 * Producer fixture for issue #1934.
 *
 * A Secrets Manager secret with a KNOWN JSON value, plus a `CfnOutput` whose
 * value is the `{{resolve:secretsmanager:<name>:SecretString:password::}}`
 * dynamic reference, carrying an `Export.Name`.
 *
 * The output is what makes the fixture discriminating. cdkd resolves it at
 * deploy time and then — since PR #1899 — PERSISTS it REDACTED: `state.outputs`
 * and the exports index hold the unresolved expression, not the plaintext. So
 * the value a cross-stack consumer reads back out of the exports index is the
 * EXPRESSION, and issue #1934 is that the consumer used to ship that literal
 * string to AWS as a property value.
 *
 * `.unsafeUnwrap()` is what puts the token in the template as a plain string.
 * It is safe here only because the "secret" is fixture data (see
 * {@link integSecretPlaintext}).
 */
export class ProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secret = new secretsmanager.Secret(this, 'CrossStackSecret', {
      secretName: SECRET_NAME,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ [SECRET_JSON_FIELD]: integSecretPlaintext() })
      ),
      // Explicit rather than inherited: the fixture must leave nothing behind,
      // and cdkd's provider force-deletes (no 7-day recovery window) so the
      // name is free again for the next run.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // A NON-secret sibling output, and it is load-bearing rather than
    // decorative: `verify.sh`'s premise check asserts that the secret-bearing
    // output is stored as its `{{resolve:...}}` expression, and that assertion
    // alone is satisfied just as well by a resolver that resolved NOTHING or a
    // redaction that blanked EVERYTHING. This output must come back RESOLVED
    // (a concrete ARN), which is what makes the premise a statement about
    // SELECTIVE redaction.
    //
    // It carries no `Export`, so it never reaches the exports index and cannot
    // interfere with the import under test.
    new cdk.CfnOutput(this, 'CrossStackSecretArnOutput', {
      value: secret.secretArn,
      description: 'ARN of the fixture secret. Non-secret control for the redaction premise.',
    });

    // THE CONDITIONAL EXPORT (issue
    // [#2150](https://github.com/go-to-k/cdkd/issues/2150)), and the shape that
    // stranded an importing stack with no way out.
    //
    // The condition compares two DIFFERENT literals, so it is false at synth
    // time, every run, on every account -- there is no parameter to set and no
    // per-run variation. The deployed export value is therefore always
    // `CONDITIONAL_PLAIN_VALUE`, while the TRUE arm the deployment never takes
    // holds a real `{{resolve:secretsmanager:...}}` expression.
    //
    // `verify.sh` proves the premise (the producer's STORED value is the plain
    // branch) before it asserts anything about the consumer, because an arm
    // whose condition had come out TRUE would be inert: the stored value would
    // then carry an expression, the discriminator would return early, and the
    // refusal under test could not fire in either direction.
    const useSecretBranch = new cdk.CfnCondition(this, 'CrossStackUseSecretBranch', {
      expression: cdk.Fn.conditionEquals('crossstack-branch-a', 'crossstack-branch-b'),
    });

    new cdk.CfnOutput(this, 'CrossStackConditionalSecretOutput', {
      value: cdk.Fn.conditionIf(
        useSecretBranch.logicalId,
        cdk.SecretValue.secretsManager(SECRET_NAME, {
          jsonField: SECRET_JSON_FIELD,
        }).unsafeUnwrap(),
        CONDITIONAL_PLAIN_VALUE
      ).toString(),
      exportName: CONDITIONAL_EXPORT_NAME,
      description:
        'An Fn::If whose UNTAKEN arm carries a secret expression. The deployed ' +
        'value is the plain branch, so a scan that sees both arms verdicts this ' +
        'export secret-bearing and then refuses over a stored value nothing can ' +
        'turn into an expression (issue 2150).',
    });

    new cdk.CfnOutput(this, 'CrossStackSecretPasswordOutput', {
      value: cdk.SecretValue.secretsManager(SECRET_NAME, {
        jsonField: SECRET_JSON_FIELD,
      }).unsafeUnwrap(),
      exportName: EXPORT_NAME,
      description:
        'Secret-bearing export. cdkd persists this REDACTED (as the unresolved ' +
        'dynamic-reference expression) in state and in the exports index, which is ' +
        'what the consumer stack reads back through Fn::ImportValue.',
    });
  }
}
