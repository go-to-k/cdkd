import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
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

    // --- SecretsManager secret with a KNOWN JSON value -----------------
    // generateSecretString is NOT used: we need a value verify.sh knows.
    const secret = new secretsmanager.Secret(this, 'DynRefSecret', {
      secretName,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ username: 'cdkd-user', password: 'cdkd-known-pw-123' })
      ),
    });
    secret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

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
        // Explicit AWSCURRENT version-stage form (cdkd supports the
        // 6-field grammar; this exercises the version-stage slot).
        SECRET_PASSWORD_STAGED: `{{resolve:secretsmanager:${secretName}:SecretString:password:AWSCURRENT}}`,
        // SSM plaintext-parameter form.
        SSM_VALUE: `{{resolve:ssm:${paramName}}}`,
      },
    });

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
