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
  public readonly staticValue: string;

  constructor(
    scope: Construct,
    id: string,
    props: { seed: string; plainSeed: string } & cdk.NestedStackProps
  ) {
    super(scope, id, props);

    // Pinned so the child's cdkd state key is the documented
    // `<parent>~Child` shape verify.sh reads.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const handler = crHandler(this, 'ChildCrHandler', 'cdkd-integ-crnoecho-nested-child');

    // Phase 3 changes both CRs' Seed, so each takes an in-place UPDATE, the
    // parent's `AWS::CloudFormation::Stack` row takes
    // `NestedStackProvider.update`, and the recovery is exercised on that arm
    // too.
    const noEchoCr = valueResource(this, 'ChildNoEchoCr', handler, {
      prefix: 'noecho-child-token',
      seed: props.seed,
      noEcho: true,
    });
    // The plain value moves in phase 3 as well: its parent reader has no
    // own-property change, so only the promotion of a nested-output reader
    // (go-to-k/cdkd#3631) can carry the new value to AWS. Phase 5 moves it
    // ALONE (`plainSeed`), so the child updates while its NoEcho CR does not
    // re-run.
    const plainCr = valueResource(this, 'ChildPlainCr', handler, {
      prefix: 'plain-child-value',
      seed: props.plainSeed,
      noEcho: false,
    });

    new cdk.CfnOutput(this, 'NoEchoToken', {
      value: noEchoCr.getAttString('Value'),
    }).overrideLogicalId('NoEchoToken');
    new cdk.CfnOutput(this, 'PlainValue', {
      value: plainCr.getAttString('Value'),
    }).overrideLogicalId('PlainValue');
    // An output NO phase moves, read by the parent's StaticParam: promoted with
    // its siblings in phase 3, it must be skipped rather than re-sent.
    new cdk.CfnOutput(this, 'StaticValue', {
      value: 'static-child-value',
    }).overrideLogicalId('StaticValue');

    const child = this.nestedStackResource as cdk.CfnResource;
    this.noEchoToken = cdk.Token.asString(child.getAtt('Outputs.NoEchoToken'));
    this.plainValue = cdk.Token.asString(child.getAtt('Outputs.PlainValue'));
    this.staticValue = cdk.Token.asString(child.getAtt('Outputs.StaticValue'));
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

    // Whole tokens: `producer-seed` (the import arm's phase) and `plain-seed`
    // must not read as `seed`, or those phases would re-run the child's NoEcho
    // CR too.
    const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    const seed = modes.includes('seed') ? 'updated' : 'integ';
    const child = new NoEchoChild(this, 'NoEchoChild', {
      seed,
      plainSeed: modes.includes('plain-seed') ? 'rotated' : seed,
    });

    // No own-property change in any phase (go-to-k/cdkd#3662). Phase 3 reaches
    // AWS only because the diff promotes a reader of an updated nested
    // stack's outputs, and the engine sends it the token the child's NoEcho CR
    // re-minted, though the record and the redacted value are both `***`.
    // Phase 5 promotes it again with nothing re-minted: it resolves the mask
    // itself, equal to its record, and must be SKIPPED rather than refused.
    new ssm.StringParameter(this, 'NoEchoParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/parent/noecho',
      stringValue: child.noEchoToken,
    });
    // No own-property change in any phase: phases 3 and 5 reach AWS only
    // through the promotion of a nested-output reader (go-to-k/cdkd#3631).
    new ssm.StringParameter(this, 'PlainParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/parent/plain',
      stringValue: child.plainValue,
    });
    // Reads the output no phase moves: promoted in phase 3, then skipped by the
    // engine's re-resolve (verify.sh asserts both log lines).
    new ssm.StringParameter(this, 'StaticParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/parent/static',
      stringValue: child.staticValue,
    });
  }
}
