import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EXPORT_NAME, SECRET_JSON_FIELD, SECRET_NAME, integSecretPlaintext } from './shared.ts';

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
