import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * `cdkd scrub` over a nested-stack CHILD record (issue
 * [#2252](https://github.com/go-to-k/cdkd/issues/2252)).
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SSM::Parameter
 *
 * The parent hands the child a secret through its `Parameters` block, and the
 * child consumes it as `{Ref: DbPassword}` — in a resource and in an output.
 * A deploy by the current binary persists the EXPRESSION in the child record;
 * verify.sh then rewrites that record the way a binary older than issue #1903
 * wrote it (plaintext in both places) and proves `cdkd scrub <parent>` finds
 * and repairs it. The `DbPassword` needle comes only from the parent's
 * resolution of the row's `Parameters`; the `ApiOut` output is the child's own
 * reference, mirrored into the parent row's attributes (issue #3961).
 *
 * `cdkd diff` over a condition on a secret-fed parameter (issue
 * [#4479](https://github.com/go-to-k/cdkd/issues/4479)): the parent also feeds
 * `Stage` from the secret, `IsLive4479` compares it to the literal the secret
 * holds, and two `Fn::If` slots on it (the parameter's `Description` and the
 * `Size4479` output) take the TRUE branch on deploy. The diff cannot read the
 * secret and used to take FALSE, reporting both as changed on an unchanged
 * stack; it now reuses the verdict the deploy recorded. Two edits the diff
 * must still report: `CDKD_4479_EDIT=literal` changes the literal the
 * condition compares against (the deploy flips to FALSE), and
 * `CDKD_4479_EDIT=swap` swaps the property's two branches.
 */
/** What verify.sh stores under the secret's `stage` key (issue #4479). */
const STAGE_VALUE_4479 = 'cdkd-4479-stage-live';

class SecretChild extends cdk.NestedStack {
  constructor(
    scope: Construct,
    id: string,
    names: { parameterName: string; apiReference: string },
    props: cdk.NestedStackProps
  ) {
    super(scope, id, props);
    // Pinned so the child's state key is the documented `<parent>~Child`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const password = new cdk.CfnParameter(this, 'DbPassword', { type: 'String' });
    password.overrideLogicalId('DbPassword');

    const stage = new cdk.CfnParameter(this, 'Stage', { type: 'String' });
    stage.overrideLogicalId('Stage');
    const edit = process.env['CDKD_4479_EDIT'];
    const isLive = new cdk.CfnCondition(this, 'IsLive4479', {
      expression: cdk.Fn.conditionEquals(
        stage.valueAsString,
        edit === 'literal' ? 'cdkd-4479-stage-production' : STAGE_VALUE_4479
      ),
    });
    isLive.overrideLogicalId('IsLive4479');
    const [whenLive, whenOther] =
      edit === 'swap'
        ? ['scrub-nested-child other', 'scrub-nested-child live']
        : ['scrub-nested-child live', 'scrub-nested-child other'];

    const param = new ssm.StringParameter(this, 'PwParam', {
      parameterName: names.parameterName,
      stringValue: password.valueAsString,
      description: cdk.Fn.conditionIf(isLive.logicalId, whenLive, whenOther).toString(),
    });
    (param.node.defaultChild as ssm.CfnParameter).overrideLogicalId('PwParam');

    const output = new cdk.CfnOutput(this, 'PwOut', { value: password.valueAsString });
    output.overrideLogicalId('PwOut');

    // An output sourced from the CHILD's own reference (issue #3961). The
    // parent row mirrors it as `attributes['Outputs.ApiOut']`, and the parent's
    // own bag has no needle for it: only the child's scrub learns one.
    const apiOutput = new cdk.CfnOutput(this, 'ApiOut', { value: names.apiReference });
    apiOutput.overrideLogicalId('ApiOut');

    const sizeOutput = new cdk.CfnOutput(this, 'Size4479', {
      value: cdk.Fn.conditionIf(isLive.logicalId, 'big-4479', 'small-4479').toString(),
    });
    sizeOutput.overrideLogicalId('Size4479');
  }
}

export class ScrubNestedChildStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // Concrete under cdkd's synth (env from CDK_DEFAULT_ACCOUNT), so the
    // reference below is one literal token verify.sh can spell too. The secret
    // itself is created OUT OF BAND by verify.sh: a `{{resolve:...}}` string
    // carries no DAG edge to an in-stack producer.
    const account = cdk.Stack.of(this).account;
    const secretName = `cdkd-scrub-nested-child-${account}`;
    new SecretChild(
      this,
      'Child',
      {
        parameterName: `cdkd-scrub-nested-child-pw-${account}`,
        apiReference: `{{resolve:secretsmanager:${secretName}:SecretString:api::}}`,
      },
      {
        parameters: {
          DbPassword: `{{resolve:secretsmanager:${secretName}:SecretString:password::}}`,
          Stage: `{{resolve:secretsmanager:${secretName}:SecretString:stage::}}`,
        },
      }
    );
  }
}
