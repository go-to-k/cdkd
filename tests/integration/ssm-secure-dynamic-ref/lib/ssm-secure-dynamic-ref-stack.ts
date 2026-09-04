import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Integ probe for issue #2482: a `{{resolve:ssm-secure:<name>}}` dynamic
 * reference must reach AWS as the SecureString parameter's VALUE, never as
 * the literal token, and must be persisted in cdkd state as the EXPRESSION.
 *
 * covers: AWS::Lambda::Function
 *
 * Pre-fix, `resolveDynamicReferences` had no arm for `ssm-secure`: the
 * spelling hit the unsupported-service warning and the literal token was
 * handed to the provider. cdkd never passes through CloudFormation, so
 * nothing resolved it server-side, and where the service API accepted the
 * string the live credential WAS the template text — with the deploy
 * exiting 0.
 *
 * The consumer is a Lambda environment variable because it READS BACK
 * (`get-function-configuration`), so verify.sh can assert what AWS actually
 * holds. That is a cdkd-only resolver check, not CloudFormation parity:
 * Lambda `Environment` is not on CloudFormation's `ssm-secure` destination
 * allowlist (IAM login password, RDS master password, ...), and cdkd does
 * not enforce that list for any service. The three forms exercised:
 *   - the WHOLE-value token,
 *   - the token EMBEDDED in a longer string (the shape `docs/cli-drift.md`
 *     used to document as "written with the token literal, exactly as
 *     `cdkd deploy` does"),
 *   - the `<name>:<version>` selector CloudFormation's grammar allows.
 *
 * The SecureString parameters are NOT declared here: CloudFormation cannot
 * create one, so verify.sh seeds them out of band (`aws ssm put-parameter
 * --type SecureString`) before the first deploy and removes them in cleanup.
 *
 * The versioned form appears TWICE. `SSM_SECURE_VERSIONED` names a SECOND
 * parameter with its own value, so the `<name>:<version>` grammar is covered
 * independently of any collision. `SSM_SECURE_VERSIONED_SAME` names the FIRST
 * parameter — the shape this fixture's first real-AWS run measured (issue
 * #2485): two expressions in one resource resolving to the SAME plaintext,
 * with the embedded leaf redacted by a value scan that carried one expression
 * per plaintext, persisted `...:{{resolve:ssm-secure:NAME:1}}@...` for a
 * template that spells `NAME`, and the next deploy diffed that leaf forever.
 * Since #2485 the embedded leaf is positioned by its own span, and this key is
 * what makes the state assertion on `SSM_SECURE_EMBEDDED` able to fail without
 * that fix. ORDER IS LOAD-BEARING: the template keeps this object's
 * declaration order (CDK sorts env keys only under `currentVersion`), cdkd
 * resolves them in that order, and the value-keyed map keeps the LAST
 * expression recorded for a plaintext — so `SSM_SECURE_VERSIONED_SAME` is
 * declared AFTER `SSM_SECURE_EMBEDDED` and the map's survivor is the `:1`
 * spelling. Move it above and the assertion passes with or without the fix;
 * verify.sh asserts the synthesized order.
 * The `{{resolve:...}}` strings are set as LITERALS on purpose — CDK's
 * `SecretValue` / `ssmSecureString` helpers synthesize to exactly this
 * spelling, and the literal keeps the fixture independent of the helper's
 * version.
 *
 * CDKD_TEST_UPDATE=true adds a tag to the function and changes nothing else:
 * the Tags-only in-place UPDATE that verify.sh uses to assert the re-deploy
 * still carries the plaintext (never the token) and leaves state on the
 * expression.
 */
export class SsmSecureDynamicRefStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Fixed name, derived the same way verify.sh derives it, so the literal
    // `{{resolve:...}}` strings below name the parameter the script seeded.
    const paramName = `cdkd-test-ssm-secure-${this.account}`;
    const versionedParamName = `cdkd-test-ssm-secure-versioned-${this.account}`;
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const fn = new lambda.Function(this, 'ConsumerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 });'),
      timeout: cdk.Duration.seconds(10),
      environment: {
        // Whole-value form.
        SSM_SECURE_WHOLE: `{{resolve:ssm-secure:${paramName}}}`,
        // Embedded form: a composed connection string carrying the token.
        SSM_SECURE_EMBEDDED: `postgres://app-svc:{{resolve:ssm-secure:${paramName}}}@db.internal:5432/app`,
        // Version-selector form (the parameter is seeded once, so version 1).
        // A separate parameter — see the docstring above for why.
        SSM_SECURE_VERSIONED: `{{resolve:ssm-secure:${versionedParamName}:1}}`,
        // The SAME parameter as the whole / embedded forms, version-pinned: the
        // #2485 collision shape — see the docstring above.
        SSM_SECURE_VERSIONED_SAME: `{{resolve:ssm-secure:${paramName}:1}}`,
        // A public control value, so a state scan that finds NO plaintext is
        // not vacuous over an env block that persisted nothing at all.
        PUBLIC_CONTROL: 'cdkd-2482-public-control',
      },
    });

    if (isUpdate) {
      // The ONLY change in the update phase.
      cdk.Tags.of(fn).add('cdkd-update-probe', 'true');
    }

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
  }
}
