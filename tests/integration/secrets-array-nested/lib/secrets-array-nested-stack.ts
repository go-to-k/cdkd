import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * Failure-seeking fixture for a secret nested in an ARRAY (issue
 * [#1915](https://github.com/go-to-k/cdkd/issues/1915)).
 *
 * covers: AWS::SecretsManager::Secret
 * covers: AWS::ECS::TaskDefinition
 *
 * It carries the real-AWS arm for issue
 * [#1917](https://github.com/go-to-k/cdkd/issues/1917) too — a secret whose
 * RESOLVED PLAINTEXT is itself a complete `{{resolve:...}}` string, which used
 * to satisfy the "this leaf is already redacted" predicate and be persisted
 * verbatim. Both of its load-bearing rows are exercised here on the same
 * deploy: the template-sourced one on the phase-1 CREATE, and the
 * same-generation observed one on the phase-2 unchanged redeploy.
 *
 * The GHSA-p5qg-v9gv-hc7w redaction keeps a resolved `{{resolve:...}}` secret
 * out of persisted state. Two independent halves do that, and on the
 * UNCHANGED-resource path BOTH were off for an array-nested leaf:
 *
 *  - Positional array descent is refused for an AWS readback, because AWS does
 *    not preserve list order (the reason `src/analyzer/drift-normalize.ts`
 *    exists) and descending by index would write the expression onto the WRONG
 *    element while leaving the real secret in plaintext.
 *  - The fallback VALUE scan has no needles: an unchanged resource is never
 *    resolved during a deploy, so its `perResourceSecrets` entry is empty
 *    (issue #1900).
 *
 * So `observedProperties.ContainerDefinitions[].Environment[].Value` kept the
 * plaintext while `properties` correctly held the expression. The fix descends
 * such arrays by an element IDENTITY KEY (`Name` here), which is
 * order-independent and therefore answers the reordering objection directly.
 *
 * Why an ECS task definition: `ContainerDefinitions[].Environment[]` is a
 * DOUBLY nested, `Name`-keyed array that really does carry secrets in practice,
 * and a task definition is free to register (no cluster, no running task, no
 * execution role on the EC2 launch type). The container images are never
 * pulled, so `busybox` is a placeholder rather than a dependency.
 *
 * The `sidecar` container and the `MODE` variable are NOT filler: they make the
 * arrays multi-element at both levels, so a fix that "descends arrays" by index
 * rather than by key produces a visibly wrong answer instead of accidentally
 * the right one.
 */
export class SecretsArrayNestedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = cdk.Stack.of(this).account;

    // Fixed names so verify.sh can build the literal `{{resolve:...}}` strings.
    const secretName = `cdkd-test-array-secret-${account}`;
    const tokenSecretName = `cdkd-test-array-token-${account}`;

    // A KNOWN value (not generateSecretString): verify.sh has to compare the
    // resolved plaintext against something it controls.
    const secret = new secretsmanager.Secret(this, 'ArraySecret', {
      secretName,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ username: 'cdkd-user', password: 'cdkd-array-nested-pw-789' })
      ),
    });
    secret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Issue #1917's secret — whose VALUE is itself a complete `{{resolve:...}}`
    // string — is created OUT OF BAND by verify.sh, and the reason is the whole
    // hazard in miniature. Declaring it here would put that string in a
    // template PROPERTY, and `resolveValue` scans every string property for
    // `{{resolve:` before any provider is called, so cdkd would try to
    // GetSecretValue the decoy name the value mentions and fail the deploy.
    //
    // Referencing it below is safe, but NOT for the general reason it is
    // tempting to write down. `resolveDynamicReferences` does collect its
    // matches from the ORIGINAL leaf before substituting any of them — however
    // `Fn::Join` and `Fn::Sub` RE-SCAN their substituted result, so a reference
    // reached through either of those WOULD have its resolved value re-scanned
    // and this decoy would be looked up after all. What makes the env var below
    // safe is narrower and load-bearing: it is a LITERAL string, so no
    // intrinsic ever sees the substitution. Switching it to
    // `secret.secretValueFromJson(...)` would render an `Fn::Join` (the ARN as
    // a `Ref`) and silently re-open the deploy failure this out-of-band
    // creation exists to avoid.

    // L1 on purpose: the L2 `TaskDefinition` would add an execution role and a
    // log group, neither of which this test needs, and both of which are extra
    // resources to reason about in the orphan sweep. The reference is written
    // as a LITERAL dynamic-reference string rather than through
    // `secretValueFromJson`, so the test does not depend on which token shape
    // the installed CDK version renders.
    const taskDef = new ecs.CfnTaskDefinition(this, 'ArraySecretTaskDef', {
      family: `cdkd-test-array-secret-${account}`,
      // EC2 launch type: no execution role required to REGISTER, unlike Fargate.
      requiresCompatibilities: ['EC2'],
      networkMode: 'bridge',
      containerDefinitions: [
        {
          name: 'app',
          image: 'public.ecr.aws/docker/library/busybox:latest',
          memory: 128,
          essential: true,
          environment: [
            // THE leaf under test: a secret two arrays deep.
            {
              name: 'DB_PASSWORD',
              value: `{{resolve:secretsmanager:${secretName}:SecretString:password}}`,
            },
            // Issue #1917, in the same array so it also rides the keyed
            // descent: this resolves to a plaintext that LOOKS like an
            // already-redacted expression.
            {
              name: 'TOKEN_SHAPED',
              value: `{{resolve:secretsmanager:${tokenSecretName}:SecretString:ref}}`,
            },
            // A non-secret sibling in the same array, so "redact everything in
            // this subtree" is a visibly wrong answer too.
            { name: 'MODE', value: 'production' },
          ],
        },
        {
          name: 'sidecar',
          image: 'public.ecr.aws/docker/library/busybox:latest',
          memory: 64,
          essential: false,
          environment: [{ name: 'ROLE', value: 'sidecar' }],
        },
      ],
    });
    taskDef.node.addDependency(secret);

    new cdk.CfnOutput(this, 'TaskDefinitionFamily', { value: taskDef.family! });
    new cdk.CfnOutput(this, 'SecretName', { value: secretName });
    new cdk.CfnOutput(this, 'TokenSecretName', { value: tokenSecretName });
  }
}
