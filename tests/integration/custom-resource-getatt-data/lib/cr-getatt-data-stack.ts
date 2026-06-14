import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Failure-seeking integ for Custom Resource response `Data` consumed via
 * `Fn::GetAtt(CustomResource, '<key>')` (a.k.a. `Data.<key>`) into ANOTHER
 * resource's property.
 *
 * Why this is fragile (issues #756 / #804): a Custom Resource's `Data`
 * attributes only exist AFTER its backing Lambda handler runs and returns a
 * SUCCESS response carrying `Data: { ... }`. cdkd's `CustomResourceProvider`
 * captures that `Data` map into `ResourceCreateResult.attributes`, and the
 * intrinsic-function resolver must then make `Fn::GetAtt(<CR>, '<key>')`
 * resolve to `attributes['<key>']` so a DEPENDENT resource created later in
 * the DAG receives the concrete value. If the resolver returns the wrong /
 * empty value, or the DAG runs the dependent BEFORE the CR's attributes are
 * populated, the dependent gets a blank / wrong property and the bug is
 * silent unless the consuming resource's value is asserted on AWS.
 *
 * Shape under test:
 *   MyCustomResource  (AWS::CloudFormation::CustomResource, inline Lambda)
 *      handler returns Data: {
 *        ComputedValue: "<echo of an input + a fixed marker>",
 *        Another:       "another-<region>",
 *        NumericValue:  "<a stringified number>",
 *      }
 *      |
 *      +--> SSM Parameter "ComputedParam"  Value = Fn::GetAtt(CR, 'ComputedValue')
 *      +--> SSM Parameter "AnotherParam"    Value = Fn::GetAtt(CR, 'Another')
 *      +--> SSM Parameter "NumericParam"    Value = Fn::GetAtt(CR, 'NumericValue')
 *
 * The SSM parameters carry explicit Names so verify.sh can read each one back
 * with `aws ssm get-parameter --name <name>` and assert the value equals the
 * value the CR's handler returned — proving the CR `Data` attribute resolved
 * THROUGH the intrinsic resolver INTO the dependent resource's property.
 *
 * No VPC. No Provider framework (deliberately the simple synchronous
 * direct-payload-return path, which is the cheapest way to surface a
 * GetAtt-of-CR-Data resolution bug). Multiple Data keys + a dependent that
 * `addDependency`s the CR make this a fan-out regression net.
 */
export class CrGetAttDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const namePrefix = `/cdkd-integ/cr-getatt-data/${id}`;

    // An inline Lambda that returns `Data` DIRECTLY in its response payload.
    // cdkd's CustomResourceProvider parses a direct payload carrying `Data`
    // (no ResponseURL round-trip needed for this simple synchronous shape).
    // The handler echoes one input property plus fixed markers so the
    // assertion proves the value came from THIS handler run, not a constant
    // baked into the template.
    const handler = new lambda.Function(this, 'CrHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  console.log('CR event:', JSON.stringify(event));
  const requestType = event.RequestType;
  const props = event.ResourceProperties || {};
  // Delete must succeed (return SUCCESS) so destroy is clean.
  if (requestType === 'Delete') {
    return {
      Status: 'SUCCESS',
      PhysicalResourceId: event.PhysicalResourceId || 'cr-getatt-data',
    };
  }
  const seed = props.Seed || 'noseed';
  const region = props.Region || 'noregion';
  // The Data map consumed via Fn::GetAtt by the SSM parameters below.
  return {
    PhysicalResourceId: 'cr-getatt-data-' + seed,
    Data: {
      ComputedValue: 'computed-' + seed,
      Another: 'another-' + region,
      NumericValue: '42',
    },
  };
};
`),
    });

    // The Custom Resource. Using new cdk.CustomResource(...) WITHOUT a
    // resourceType makes CDK emit AWS::CloudFormation::CustomResource (the
    // Lambda-backed type cdkd's CustomResourceProvider drives).
    const cr = new cdk.CustomResource(this, 'MyCustomResource', {
      serviceToken: handler.functionArn,
      properties: {
        // A unique-ish seed so re-deploys produce a distinct echoed value.
        Seed: 'integ',
        Region: this.region,
      },
    });

    // Dependent #1: Value = Fn::GetAtt(CR, 'ComputedValue').
    const computedParam = new ssm.StringParameter(this, 'ComputedParam', {
      parameterName: `${namePrefix}/computed`,
      stringValue: cr.getAttString('ComputedValue'),
    });

    // Dependent #2: Value = Fn::GetAtt(CR, 'Another') — second Data key, so a
    // resolver that only wires the first attribute would fail HERE.
    new ssm.StringParameter(this, 'AnotherParam', {
      parameterName: `${namePrefix}/another`,
      stringValue: cr.getAttString('Another'),
    });

    // Dependent #3: Value = Fn::GetAtt(CR, 'NumericValue') — a stringified
    // number, to catch a resolver that mishandles non-text Data values.
    new ssm.StringParameter(this, 'NumericParam', {
      parameterName: `${namePrefix}/numeric`,
      stringValue: cr.getAttString('NumericValue'),
    });

    // Make the CR->dependent ordering explicit (CDK already adds the Ref edge
    // via getAttString, but an explicit addDependency documents intent and
    // guards against a future refactor dropping the implicit edge).
    computedParam.node.addDependency(cr);

    // Surface the resolved values as outputs too, so verify.sh has a
    // belt-and-suspenders cross-check (state.outputs) alongside the on-AWS
    // SSM read.
    new cdk.CfnOutput(this, 'ComputedParamName', {
      value: computedParam.parameterName,
      description: 'SSM parameter name whose Value is Fn::GetAtt(CR, ComputedValue)',
    });
    new cdk.CfnOutput(this, 'ComputedValueResolved', {
      value: cr.getAttString('ComputedValue'),
      description: 'The CR ComputedValue Data attr resolved at synth/deploy time',
    });
  }
}
