import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * The secret flow across a NESTED-STACK boundary, in BOTH directions.
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SSM::Parameter
 *
 * Issues [#1903](https://github.com/go-to-k/cdkd/issues/1903) (parameters IN),
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055) (outputs OUT),
 * [#2086](https://github.com/go-to-k/cdkd/issues/2086) (the rollback executor
 * binds the same seed) and [#2087](https://github.com/go-to-k/cdkd/issues/2087)
 * (the seed is scoped to the resources that actually consumed the parameter).
 *
 * Nothing here creates the secret or the SecureString parameter: `verify.sh`
 * puts both in place out of band and deletes them again. CloudFormation cannot
 * create a SecureString at all, and keeping the secretsmanager one out of band
 * too means this stack never has to order a `{{resolve:...}}` consumer behind
 * its own producer — the references are literal strings, so no DAG edge exists
 * to enforce such an ordering.
 *
 * WHY THE PARENT/CHILD SPLIT MATTERS. cdkd's redaction rests on the resolver
 * recording `plaintext -> {{resolve:...}} expression` and the deploy engine
 * reading that at its state-save choke point. A nested stack breaks the chain:
 * the PARENT resolves the child's `Parameters` block, so the child engine
 * receives PLAINTEXT and the child's own template spells the consumption as
 * `{Ref: <ParamName>}` — an intrinsic OBJECT, never a `{{resolve:` string.
 *
 * THE FOUR RESOURCES, and what each one discriminates:
 *
 *  - `StageParam` (child) — consumes the secretsmanager-backed parameter. Its
 *    persisted `Value` must be the EXPRESSION while the live SSM parameter
 *    holds the plaintext.
 *  - `SecureParam` (child) — the same for a SecureString `{{resolve:ssm:...}}`,
 *    which is a secret by the parameter's TYPE rather than by its spelling
 *    (issue #1901), so it exercises the classification arm as well.
 *  - `UnrelatedParam` (child) — THE #2087 DISCRIMINATOR. An ordinary literal
 *    that CONTAINS the secret plaintext as a SUBSTRING and references no
 *    parameter at all. Its persisted `Value` must stay VERBATIM. The first cut
 *    of #1903 seeded the parent's bag into every child resource's redaction
 *    map, and `redactSecretsForState` substring-matches, so this row persisted
 *    with the expression spliced in — which the desired side never mirrors,
 *    giving a perpetual UPDATE. A literal that did NOT overlap could not see
 *    the defect at all.
 *  - `ParentConsumer` (parent) — reads the child's OUTPUT through
 *    `Fn::GetAtt: [Child, 'Outputs.ChildSecretOutput']`. Since PR #1899 the
 *    child persists that output REDACTED, so before #2055 the parent shipped
 *    the literal `{{resolve:...}}` token to AWS. The live parameter must hold
 *    the resolved secret and the parent's own state must hold the expression.
 */
class SecretBearingChild extends cdk.NestedStack {
  /** The child's output, for the parent to consume via `Fn::GetAtt`. */
  public readonly stageOutput: string;

  constructor(
    scope: Construct,
    id: string,
    names: {
      stageParamName: string;
      secureParamName: string;
      unrelatedParamName: string;
      unrelatedLiteral: string;
      stageParamDescription: string;
    },
    props?: cdk.NestedStackProps
  ) {
    super(scope, id, props);

    // Pin the `AWS::CloudFormation::Stack` logical id so the cdkd state key is
    // the documented `<parent>~Child` shape rather than CDK's auto-generated
    // compound, which verify.sh would otherwise have to discover. See
    // `tests/integration/nested-stack` and issue #575.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    // The two inputs the parent resolves on this stack's behalf. Declared with
    // pinned logical ids because the parent's `Parameters` block keys on them
    // and verify.sh asserts against those exact names in the parent's state.
    const stage = new cdk.CfnParameter(this, 'SecretStage', { type: 'String' });
    stage.overrideLogicalId('SecretStage');
    const securePassword = new cdk.CfnParameter(this, 'SecurePassword', { type: 'String' });
    securePassword.overrideLogicalId('SecurePassword');

    const stageParam = new ssm.StringParameter(this, 'StageParam', {
      parameterName: names.stageParamName,
      // `{Ref: SecretStage}` in the child's template — an intrinsic OBJECT, so
      // nothing in the child's own resolution ever sees a `{{resolve:`.
      stringValue: stage.valueAsString,
      // VARIES BY `CDKD_TEST_UPDATE` (see the parent below). Changing a child
      // property is what makes the parent's `Child` row an UPDATE, which is the
      // only way this fixture reaches `NestedStackProvider.update` — the #1903
      // arm for a nested stack that ALREADY exists. Before this the fixture's
      // second deploy was a no-op, so that arm never ran here at all.
      description: names.stageParamDescription,
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((stageParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('StageParam');

    const secureParam = new ssm.StringParameter(this, 'SecureParam', {
      parameterName: names.secureParamName,
      stringValue: securePassword.valueAsString,
      description: 'cdkd nested-stack-secret integ - child consumer of the SecureString parameter',
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((secureParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('SecureParam');

    const unrelatedParam = new ssm.StringParameter(this, 'UnrelatedParam', {
      parameterName: names.unrelatedParamName,
      // NO intrinsic. This value is a plain literal that merely happens to
      // contain the secret plaintext as a substring.
      stringValue: names.unrelatedLiteral,
      description:
        'cdkd nested-stack-secret integ - #2087 discriminator: an unrelated literal containing the secret plaintext',
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((unrelatedParam.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('UnrelatedParam');

    const output = new cdk.CfnOutput(this, 'ChildSecretOutput', {
      value: stage.valueAsString,
      description: 'cdkd nested-stack-secret integ - secret-derived child output (issue #2055)',
    });
    output.overrideLogicalId('ChildSecretOutput');

    this.stageOutput = cdk.Token.asString(
      (this.nestedStackResource as cdk.CfnResource).getAtt('Outputs.ChildSecretOutput')
    );
  }
}

export class NestedStackSecretStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = cdk.Stack.of(this).account;

    // Phase 2c of `verify.sh` re-deploys with `CDKD_TEST_UPDATE=child-property`
    // so the CHILD template genuinely changes. Two things follow, and the
    // second is the point: the child's `StageParam` takes an in-place UPDATE,
    // and the parent's `AWS::CloudFormation::Stack` row changes with the
    // nested template's asset hash — so the parent's provisioning takes
    // `NestedStackProvider.update`, i.e. the arm whose seed binding (issue
    // #1903, `deploy-engine.ts`'s UPDATE call site) this fixture could not
    // exercise while its second deploy was a no-op.
    //
    // A DESCRIPTION rather than a value: the three child parameters' VALUES are
    // what every redaction assertion is written against, and `UnrelatedParam`'s
    // literal in particular has to stay byte-identical for the #2087 arm.
    const updateMode = process.env['CDKD_TEST_UPDATE'] ?? '';
    const stageParamDescription = updateMode.includes('child-property')
      ? 'cdkd nested-stack-secret integ - child consumer of the secretsmanager parameter (updated)'
      : 'cdkd nested-stack-secret integ - child consumer of the secretsmanager parameter';

    // Fixed, account-scoped names so verify.sh can build the `{{resolve:...}}`
    // strings and read every resource back deterministically. Simple
    // (non-hierarchical) names: a leading-slash SSM name combined with an
    // unresolved account token breaks CDK's ARN-separator derivation.
    const secretName = `cdkd-nested-secret-${account}`;
    const secureParamName = `cdkd-nested-secure-${account}`;

    // The two references the PARENT resolves before handing the values down.
    // Spelled as literal strings rather than through `SecretValue`, so the test
    // exercises the exact dynamic-reference grammar rather than whichever token
    // shape the installed CDK happens to emit.
    const stageReference = `{{resolve:secretsmanager:${secretName}:SecretString:stage::}}`;
    const secureReference = `{{resolve:ssm:${secureParamName}}}`;

    const child = new SecretBearingChild(
      this,
      'Child',
      {
        stageParamName: `cdkd-nested-child-stage-${account}`,
        secureParamName: `cdkd-nested-child-secure-${account}`,
        unrelatedParamName: `cdkd-nested-child-unrelated-${account}`,
        // Contains the secret's resolved plaintext (`prodstage2087`) as a
        // substring. Kept in sync with verify.sh's SECRET_STAGE_VALUE — and
        // verify.sh now ASSERTS the overlap rather than trusting this comment,
        // because a drift here would leave the #2087 arm passing VACUOUSLY (a
        // non-overlapping literal cannot see the defect at all).
        unrelatedLiteral: 'cdkd-bucket-prodstage2087-logs',
        stageParamDescription,
      },
      {
        parameters: {
          SecretStage: stageReference,
          SecurePassword: secureReference,
        },
      }
    );

    const parentConsumer = new ssm.StringParameter(this, 'ParentConsumer', {
      parameterName: `cdkd-nested-parent-consumer-${account}`,
      // `Fn::GetAtt: [Child, 'Outputs.ChildSecretOutput']` — the child's
      // persisted output is REDACTED, so this is the read site issue #2055 is
      // about.
      stringValue: child.stageOutput,
      description:
        'cdkd nested-stack-secret integ - parent consumer of the child output (issue #2055)',
    });
    // Pinned so verify.sh can assert on this row by a stable key. CDK's
    // default logical id carries a hash that moves with the construct path.
    ((parentConsumer.node.defaultChild as ssm.CfnParameter)).overrideLogicalId('ParentConsumer');
  }
}
