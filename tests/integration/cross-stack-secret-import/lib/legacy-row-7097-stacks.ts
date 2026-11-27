import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * go-to-k/cdkd#7097's pair, built only when `CDKD_TEST_7097=1` (verify.sh's
 * own step, on its own state bucket), so every other step's `deploy --all`
 * never sees it.
 *
 * The producer's nested row passes `X = <pin>/<long>`: a 2-character
 * SecureString (`CDKD_7097_PIN_PARAM`) beside a long one, a parameter mixing
 * a secret reference with other text (#7068's shape). The child's `Piece`
 * output is the pin itself (`Select 0` over `Split "/"`), re-exported by the
 * root. The consumer imports it into an output. verify.sh rewrites the row record's
 * `Outputs.Piece` to the plaintext, as a deploy before cdkd masked a
 * secret-derived nested output left it.
 */
class Row7097 extends cdk.NestedStack {
  readonly piece: string;
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps) {
    super(scope, id, props);
    const x = new cdk.CfnParameter(this, 'X', { type: 'String' });
    x.overrideLogicalId('X');
    const piece = new cdk.CfnOutput(this, 'Piece', {
      value: cdk.Fn.select(0, cdk.Fn.split('/', x.valueAsString)),
    });
    piece.overrideLogicalId('Piece');
    this.piece = 'Piece';
  }
}

export class Producer7097Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { pinParam: string; longParam: string; exportName: string }) {
    super(scope, id, props);
    const row = new Row7097(this, 'Row', {
      parameters: {
        X: `{{resolve:ssm-secure:${props.pinParam}}}/{{resolve:ssm-secure:${props.longParam}}}`,
      },
    });
    (row.nestedStackResource as cdk.CfnResource).overrideLogicalId('Row');
    const out = new cdk.CfnOutput(this, 'Out', {
      value: (row.nestedStackResource as cdk.CfnResource).getAtt('Outputs.Piece').toString(),
      exportName: props.exportName,
    });
    out.overrideLogicalId('Out');
  }
}

export class Consumer7097Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { exportName: string; parameterName: string }) {
    super(scope, id, props);
    // A resource of its own, holding no import: a PROPERTY reading the masked
    // export is refused, as on a current record, which is the design.
    const marker = new ssm.StringParameter(this, 'Marker', {
      parameterName: props.parameterName,
      stringValue: 'cdkd-7097-consumer',
    });
    (marker.node.defaultChild as ssm.CfnParameter).overrideLogicalId('Marker');
    // The import, read by an OUTPUT: printed by the plan and persisted.
    const shown = new cdk.CfnOutput(this, 'Shown', {
      value: cdk.Fn.join('', ['pre-', cdk.Fn.importValue(props.exportName)]),
    });
    shown.overrideLogicalId('Shown');
  }
}
