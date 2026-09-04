import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Failure-seeking fixture for CloudFormation DYNAMIC REFERENCES
 * (`{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}`).
 *
 * cdkd resolves these itself in `resolveDynamicReferences`
 * (src/deployment/intrinsic-function-resolver.ts) BEFORE handing the
 * property to the provider — CloudFormation never sees them. This fixture
 * surfaces bugs where a dynamic reference resolves to the WRONG value or
 * stays as the literal `{{resolve:...}}` string in the deployed resource.
 *
 * Resources (all cheap, no VPC):
 *   - A SecretsManager secret with a KNOWN JSON value (so verify.sh can
 *     assert the resolved value against a value it controls).
 *   - An SSM String parameter with a KNOWN value.
 *   - (NOT declared here) an SSM SecureString parameter that verify.sh creates
 *     out of band — CloudFormation cannot create one — and that the consumer
 *     Lambda references through the plain `{{resolve:ssm:...}}` form. It
 *     decrypts to a real secret, so issue #1901 requires state to hold the
 *     expression while the String parameter above stays resolved.
 *   - A consumer Lambda whose ENVIRONMENT VARIABLES are literal
 *     `{{resolve:...}}` dynamic-reference strings. cdkd resolves them at
 *     deploy time; verify.sh reads `GetFunctionConfiguration` and asserts
 *     each env var carries the RESOLVED value (never the literal token).
 *
 * The secret name / param name carry a fixed suffix so verify.sh can
 * construct the `{{resolve:...}}` strings — they are SET HERE as literal
 * env-var strings rather than via CDK's `secretValueFromJson` token so the
 * test exercises the exact dynamic-reference forms we care about, and does
 * not depend on which token shape the CDK version happens to emit.
 */
export class SecretsDynamicRefStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = cdk.Stack.of(this).account;

    // Fixed names so the literal {{resolve:...}} strings below (and
    // verify.sh) can reference them deterministically.
    const secretName = `cdkd-test-dynref-secret-${account}`;
    // Simple (non-hierarchical) name: a leading-slash hierarchical name with
    // an unresolved account token makes CDK fail ARN-separator derivation.
    const paramName = `cdkd-test-dynref-param-${account}`;
    // The SAME secret name with the account CONCRETE (issue #2485): `account`
    // above is a CDK token, so every env var built from it synthesizes as an
    // `Fn::Join`, and the leaf this issue is about must be a plain STRING in
    // the template. cdkd's synth exports `CDK_DEFAULT_ACCOUNT` to the app
    // (`src/synthesis/app-executor.ts`); verify.sh guards the premise by
    // asserting the synthesized leaf really is a string.
    const literalSecretName = `cdkd-test-dynref-secret-${process.env['CDK_DEFAULT_ACCOUNT'] ?? account}`;
    // SecureString counterpart (issue #1901). NOT declared as a CDK resource:
    // CloudFormation cannot CREATE a SecureString parameter, so verify.sh
    // creates and deletes it out of band with `aws ssm put-parameter
    // --type SecureString` before the first deploy. The stack only REFERENCES
    // it, which is exactly the path under test.
    const secureParamName = `cdkd-test-dynref-secure-${account}`;

    // --- SecretsManager secret with a KNOWN JSON value -----------------
    // generateSecretString is NOT used: we need a value verify.sh knows.
    const secret = new secretsmanager.Secret(this, 'DynRefSecret', {
      secretName,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ username: 'cdkd-user', password: 'cdkd-known-pw-123' })
      ),
    });
    secret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // CDKD_TEST_REMOVAL (issue #1160, secretsmanager batch): the baseline
    // template sets Description + KmsKeyId (the AWS-managed key alias) via the
    // L1 escape hatch; the removal phase drops both properties entirely.
    // UpdateSecret MERGES (absent = "no change"), so pre-fix the live secret
    // silently kept both values; the provider must reset Description to ''
    // and KmsKeyId to '' (the documented "use aws/secretsmanager" sentinel,
    // which restores the pristine no-explicit-key shape).
    if (process.env.CDKD_TEST_REMOVAL !== 'true') {
      const cfnSecret = secret.node.defaultChild as secretsmanager.CfnSecret;
      cfnSecret.description = 'cdkd f1160 removal-reset probe';
      cfnSecret.kmsKeyId = 'alias/aws/secretsmanager';
    }

    // --- SSM String parameter with a KNOWN value -----------------------
    const param = new ssm.StringParameter(this, 'DynRefParam', {
      parameterName: paramName,
      // simpleName must be set explicitly because paramName embeds an
      // unresolved account token (CDK cannot otherwise infer the ARN shape).
      simpleName: true,
      stringValue: 'cdkd-known-ssm-value',
    });

    // --- Consumer Lambda whose env vars are dynamic references ---------
    // Inline code keeps this asset-free + cheap. The handler is never
    // invoked by the test; verify.sh reads the function CONFIGURATION
    // (env vars) to assert the references resolved.
    // CDKD_TEST_ROLLBACK (GHSA rollback replay, issue #1899 review): add a
    // NON-secret env var so the ROLLBACK phase's redeploy issues a real UPDATE
    // to this secret-bearing Lambda (its secret env vars are unchanged, but the
    // whole Environment.Variables map is re-sent). The completed Lambda UPDATE
    // is journaled with a previousState whose secret env vars are the REDACTED
    // {{resolve:...}} expressions; a paired failing resource (below) then fails
    // the deploy, and a standalone `cdkd rollback` must re-resolve those
    // expressions to the concrete secret rather than replaying the literal
    // token. verify.sh asserts the rolled-back Lambda carries the RESOLVED
    // value.
    const rollbackProbe = process.env.CDKD_TEST_ROLLBACK === 'true';
    const fn = new lambda.Function(this, 'ConsumerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ statusCode: 200 });'
      ),
      timeout: cdk.Duration.seconds(10),
      environment: {
        // JSON-key form: resolve a single key out of the secret's JSON.
        SECRET_PASSWORD: `{{resolve:secretsmanager:${secretName}:SecretString:password}}`,
        // Whole-secret form (no JSON key): resolve the full SecretString.
        SECRET_FULL: `{{resolve:secretsmanager:${secretName}:SecretString}}`,
        // A LITERAL string EMBEDDING the same `:password` reference SECRET_PASSWORD
        // holds whole (issue #2485). No CDK token is interpolated on purpose:
        // the template must carry this as a plain string, not an `Fn::Join`
        // (DB_URL below is the intrinsic shape), because the defect is in how a
        // literal leaf is redacted (hence `literalSecretName`). It shares its plaintext with
        // SECRET_PASSWORD_STAGED. ORDER IS LOAD-BEARING: cdkd resolves env
        // vars in the template's key order, the value-keyed map keeps the
        // LAST expression recorded for a plaintext, and pre-#2485 the embedded
        // leaf was redacted by that map — so with STAGED resolving later, state
        // spelled this leaf `...:password:AWSCURRENT}}@...` for a template
        // that says `:password}}@`, and every later deploy diffed it. The
        // template keeps this object's DECLARATION order (CDK's
        // `renderEnvironment` sorts env keys only when `currentVersion` is in
        // play, which this fixture never uses), so the position of this key
        // above SECRET_PASSWORD_STAGED is what decides. Move it below and the
        // assertion passes with or without the fix; verify.sh asserts the
        // synthesized order for exactly that reason.
        DB_DSN_LITERAL: `postgres://app-svc:{{resolve:secretsmanager:${literalSecretName}:SecretString:password}}@db.internal:5432/app`,
        // Explicit AWSCURRENT version-stage form (cdkd supports the
        // 6-field grammar; this exercises the version-stage slot).
        //
        // The JSON key is `password`, DELIBERATELY the same one SECRET_PASSWORD
        // reads, so the two references resolve to the SAME plaintext. That is
        // the collision itself, and it is the point of this env var.
        //
        // The redaction map is keyed by the resolved VALUE, so the pair
        // collapses to one entry and — before issues #1904 / #1910 — state
        // persisted the staged spelling at BOTH leaves, giving the stack a
        // permanent spurious UPDATE and giving a rollback replay the wrong
        // reference to re-resolve. This arm used to read `username` instead
        // precisely to dodge that while it was unfixed; #1910 restored it.
        //
        // Do NOT "tidy" this back to a different key: the `diff --fail` guard
        // and the state-expression assertions in verify.sh are only meaningful
        // BECAUSE the two references share a value. With distinct keys they
        // pass no matter what the redaction does.
        SECRET_PASSWORD_STAGED: `{{resolve:secretsmanager:${secretName}:SecretString:password:AWSCURRENT}}`,
        // SSM plaintext-parameter form. Public config: state stores this
        // RESOLVED, which is the discriminator for the SecureString case below.
        SSM_VALUE: `{{resolve:ssm:${paramName}}}`,
        // SSM SecureString via the PLAIN `ssm:` form (issue #1901). cdkd
        // resolves with WithDecryption, so this yields a real secret and must
        // be persisted as the unresolved expression — exactly like a
        // secretsmanager reference, and unlike SSM_VALUE above.
        SSM_SECURE_VALUE: `{{resolve:ssm:${secureParamName}}}`,
        // MIXED leaf (issue #1926 review): the reference sits INSIDE surrounding
        // text instead of being the WHOLE value. That distinction is the whole
        // point — `redactByPath` substitutes a source leaf only when it is a
        // COMPLETE `{{resolve:...}}` token, so on any path whose secrets map is
        // empty (an UNCHANGED resource; `cdkd state refresh-observed`) this
        // shape fell through to a value scan with no needles and the DECRYPTED
        // value was persisted. It is also the dominant CDK shape: an
        // `Fn::Join` around `secret.secretValueFromJson(...)`.
        //
        // `cdk.Aws.REGION` is interpolated to FORCE that `Fn::Join`. Every other
        // env var here is a plain literal (the names are synth-time strings), so
        // without a token in the string CDK would constant-fold this one too and
        // the template would never carry the intrinsic.
        //
        // Built on the SECURE ssm parameter rather than the secret's password
        // deliberately, for two independent reasons: the password already
        // participates in the SECRET_PASSWORD / _STAGED collision that Guard 3
        // exists to fence, and a third reference resolving to the same value
        // would perturb which expression the value-keyed map keeps; and the
        // SecureString's plaintext has NO legitimate home anywhere in state
        // (unlike the secret's own `SecretString`, which the DynRefSecret
        // resource legitimately holds), which is what lets Phase 1g grep the
        // WHOLE state document for it rather than one key.
        // The user component is deliberately NOT `cdkd-user`: that is the secret's
        // OWN username, and `EXPECTED_USERNAME` is grepped against the whole
        // persisted env to prove SECRET_FULL's whole-secret resolution did not
        // land there. A literal equal to that needle makes this env var itself
        // trip the guard -- a FALSE leak report that looks exactly like a real
        // one. Any literal added here must not collide with an assertion needle.
        DB_URL: `postgres://app-svc:{{resolve:ssm:${secureParamName}}}@db.${cdk.Aws.REGION}.internal:5432/app`,
        // A SECOND reference to the SAME SecureString (issue #2012). Its job is
        // to give Phase 1f2 a leaf it can orphan: that phase deletes this key
        // from the record's persisted `properties` and refreshes, producing the
        // shape the issue calls "an observed KEY the source does not carry" —
        // AWS reports the key, the position source does not carry it, and
        // before the derived-needle mechanism there was neither a source leaf
        // to take nor a needle to match, so the DECRYPTED value was persisted.
        //
        // The SAME expression as SSM_SECURE_VALUE, not a different one: the
        // needle is learned from that sibling, and two DIFFERENT expressions
        // resolving to one plaintext are POISONED by design (the #1910
        // wrong-reference class), which would make this arm assert the residual
        // rather than the closure.
        SSM_SECURE_COPY: `{{resolve:ssm:${secureParamName}}}`,
        // A PUBLIC mixed leaf (issue #2036), the counterpart of DB_URL. Same
        // shape — a reference embedded in surrounding text, forced into an
        // `Fn::Join` by the region token — but built on the PUBLIC `ssm` String
        // parameter, whose resolved value must STAY resolved in state.
        //
        // With an empty secrets map the pass cannot tell a public parameter
        // from a `SecureString` by spelling, so it used to substitute the
        // expression here and give the drift baseline a value AWS does not
        // hold. Phase 1g asserts the resolved value survives on the DEPLOY
        // path, where the resolver has classified the parameter through a real
        // `GetParameter`; Phase 1f asserts the refusal still stands on `cdkd
        // state refresh-observed`, which resolves nothing and therefore has no
        // verdict to consult.
        PUBLIC_URL: `https://{{resolve:ssm:${paramName}}}.${cdk.Aws.REGION}.example.internal`,
        // Rollback-probe-only extra (forces a Lambda UPDATE this phase; the
        // rollback removes it). NOT gated as a mode-gated CREATE — the env var
        // is added to an existing resource, and the fixture reverts it via
        // rollback, never a later deploy that drops it.
        ...(rollbackProbe ? { ROLLBACK_EXTRA: 'v2' } : {}),
      },
    });

    // CDKD_TEST_ROLLBACK: a resource that FAILS at CREATE (MessageRetentionPeriod
    // is below SQS's 60s floor), depending on the Lambda so the Lambda UPDATE
    // completes and is journaled BEFORE this create fails the deploy. Mirrors the
    // `basic` fixture's CDKD_TEST_FAIL injection. An out-of-range value fails AWS
    // validation, so nothing is created (no orphan to clean up).
    if (rollbackProbe) {
      // allow-mode-gated-drop: failure-injection queue that never succeeds at CREATE; the rollback and every later phase correctly omit it.
      const failing = new sqs.CfnQueue(this, 'RollbackFailQueue', {
        messageRetentionPeriod: 30, // invalid: below the 60s minimum -> CreateQueue rejects
      });
      failing.addDependency(fn.node.defaultChild as lambda.CfnFunction);
    }

    // The Lambda must read the secret/param? No — cdkd resolves the
    // references at deploy time, so no runtime IAM is needed. We still
    // ensure deploy ordering: the env-var resolution happens against the
    // already-created secret + param, so the consumer depends on both.
    fn.node.addDependency(secret);
    fn.node.addDependency(param);

    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'SecretName', { value: secretName });
    new cdk.CfnOutput(this, 'ParamName', { value: paramName });
  }
}
