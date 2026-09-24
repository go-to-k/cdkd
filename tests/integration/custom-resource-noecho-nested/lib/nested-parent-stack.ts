import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { crHandler, valueResource } from './shared.ts';

/**
 * The CHILD: a `NoEcho` custom resource and an ordinary one, each feeding a
 * child OUTPUT the parent reads with `Fn::GetAtt [Child, 'Outputs.<Key>']`.
 *
 * Both outputs carry custom-resource `Data`, so the negative control crosses
 * the SAME boundary by the SAME route as the sensitive value and differs from
 * it only in the handler's `NoEcho` declaration.
 */
class NoEchoChild extends cdk.NestedStack {
  public readonly noEchoToken: string;
  public readonly plainValue: string;

  constructor(scope: Construct, id: string, props: { seed: string } & cdk.NestedStackProps) {
    super(scope, id, props);

    // Pinned so the child's cdkd state key is the documented
    // `<parent>~Child` shape verify.sh reads.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const handler = crHandler(this, 'ChildCrHandler', 'cdkd-integ-crnoecho-nested-child');

    // Phase 2 changes ONLY this resource's Seed, so the child CR takes an
    // in-place UPDATE, the parent's `AWS::CloudFormation::Stack` row takes
    // `NestedStackProvider.update`, and the recovery is exercised on that arm
    // too.
    const noEchoCr = valueResource(this, 'ChildNoEchoCr', handler, {
      prefix: 'noecho-child-token',
      seed: props.seed,
      noEcho: true,
    });
    const plainCr = valueResource(this, 'ChildPlainCr', handler, {
      prefix: 'plain-child-value',
      seed: 'integ',
      noEcho: false,
    });

    new cdk.CfnOutput(this, 'NoEchoToken', {
      value: noEchoCr.getAttString('Value'),
    }).overrideLogicalId('NoEchoToken');
    new cdk.CfnOutput(this, 'PlainValue', {
      value: plainCr.getAttString('Value'),
    }).overrideLogicalId('PlainValue');

    const child = this.nestedStackResource as cdk.CfnResource;
    this.noEchoToken = cdk.Token.asString(child.getAtt('Outputs.NoEchoToken'));
    this.plainValue = cdk.Token.asString(child.getAtt('Outputs.PlainValue'));
  }
}

/**
 * The nested-stack arm of issue #2460: a `NoEcho` custom-resource value
 * crossing a NESTED-STACK boundary inside one deploy.
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::SSM::Parameter
 * covers: AWS::Lambda::Function
 *
 * The child engine persists its outputs MASKED (issue #2274), and the parent
 * reads them back from the child's persisted state. What keeps this deployable
 * is the in-run recovery (`recordRecoverableMaskedOutput` ->
 * `NestedStackProvider.readChildOutputsAsAttributes`), which must hand the
 * parent's `NoEchoParam` the REAL token for the wire while the parent's own
 * record, and the parameter's, persist `***` — and must report the recovered
 * output PER ATTRIBUTE, so `PlainParam`'s value stays in the clear.
 */
export class NestedParentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Whole tokens: `producer-seed` (the import arm's phase) must not read as
    // `seed`, or that phase would update the child too.
    const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    const seedMode = modes.includes('seed');
    const child = new NoEchoChild(this, 'NoEchoChild', {
      seed: seedMode ? 'updated' : 'integ',
    });

    new ssm.StringParameter(this, 'NoEchoParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/parent/noecho',
      stringValue: child.noEchoToken,
      // An OWN-property change on the same token as the child's Seed, so this
      // parameter is a genuine UPDATE in phase 3 and re-resolves the child's
      // output from the in-flight `Child` row, i.e. from what the recovery on
      // `NestedStackProvider.update` handed back. Without it the parameter
      // diffs NO_CHANGE: a dependent reading a nested output is not promoted
      // when only the output moves (go-to-k/cdkd#3631), so it would never be
      // provisioned and phase 3 would read the OLD token back from AWS. Even
      // promoted, the engine's post-resolution skip would compare `***` with
      // `***` and drop the update (go-to-k/cdkd#3662): both must land before
      // this can go.
      description: seedMode
        ? 'cdkd integ custom-resource-noecho-nested - phase 3'
        : 'cdkd integ custom-resource-noecho-nested - phase 1',
    });
    new ssm.StringParameter(this, 'PlainParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/parent/plain',
      stringValue: child.plainValue,
    });
  }
}
