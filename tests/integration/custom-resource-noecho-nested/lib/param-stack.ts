import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { crHandler, noEchoLayer, noEchoNonce, valueResource } from './shared.ts';

/**
 * The CHILD of {@link ParamParentStack}: it reads its parent's NoEcho custom
 * resource value only through a stack PARAMETER (`Ref ParentToken`).
 */
class ParamChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pinned so the child's cdkd state key is `<parent>~ParamChild`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('ParamChild');

    const token = new cdk.CfnParameter(this, 'ParentToken', { type: 'String' });
    new ssm.StringParameter(this, 'ParentTokenParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/param-child/token',
      stringValue: token.valueAsString,
    });
    // The child-parameter path's create-only reader (go-to-k/cdkd#3729):
    // replaced in phase 6, where the token moves, and left alone in phase 7,
    // where the parent's CR re-runs and returns the same token.
    noEchoLayer(
      this,
      'ParamChildLayer',
      'cdkd-integ-crnoecho-nested-paramchild-layer',
      token.valueAsString
    );
  }
}

/**
 * Two readers whose value moves only when a custom resource in THIS stack
 * re-runs, flipped together by `CDKD_TEST_UPDATE=parent-seed` (verify.sh
 * phase 6). Its own stack, so no other phase touches it: a nested stack row
 * whose `Parameters` read a NoEcho value from state is refused on any update
 * that does not re-run that custom resource (issue #2274), and the child-only
 * changes of the other stacks' phases would trip that here.
 *
 * - go-to-k/cdkd#3717: `ParamChild`'s `ParentTokenParam` reads the parent's
 *   NoEcho token through a stack parameter. The child's diff sees `***` against
 *   its recorded `***`, so only the fresh-parameter promotion sends it the new
 *   token.
 * - go-to-k/cdkd#3722: `IdRefParam` reads `Ref IdCr`, and `IdCr`'s handler
 *   answers an Update with a new PhysicalResourceId.
 *
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::SSM::Parameter
 * covers: AWS::Lambda::Function
 * covers: AWS::Lambda::LayerVersion
 */
export class ParamParentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',');
    const seed = modes.includes('parent-seed') ? 'rotated' : 'integ';
    const handler = crHandler(this, 'ParamCrHandler', 'cdkd-integ-crnoecho-nested-param');

    const tokenCr = valueResource(this, 'ParentNoEchoCr', handler, {
      prefix: 'noecho-param-token',
      seed,
      noEcho: true,
      nonce: noEchoNonce(),
    });
    new ParamChild(this, 'ParamChild', {
      parameters: { ParentToken: tokenCr.getAttString('Value') },
    });

    const idCr = valueResource(this, 'IdCr', handler, {
      prefix: 'id-value',
      seed,
      noEcho: false,
      idFromSeed: true,
    });
    new ssm.StringParameter(this, 'IdRefParam', {
      parameterName: '/cdkd-integ/cr-noecho-nested/param-parent/id-ref',
      stringValue: idCr.ref,
    });
  }
}
