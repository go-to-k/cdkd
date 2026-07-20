import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Error-path fixture for the Fn::GetAtt unknown-attribute ARN-shape guard
 * (issue #1106). covers: AWS::SSM::Parameter
 *
 * `AWS::SSM::Parameter` has NO per-type handler in the resolver's
 * `constructAttribute` switch, and its SDK provider stores only
 * `{Type, Value}` in `attributes` with the parameter NAME as the
 * physicalId — so `Fn::GetAtt [Probe, BogusArn]` reaches the final
 * unknown-attribute fallback, where the physicalId is not ARN-shaped and
 * the deploy must now HARD-FAIL with an actionable error instead of
 * shipping the wrong value with a warning (the #1103 incident class).
 *
 * The bogus GetAtt is consumed by a second parameter's Value — a RESOURCE
 * property, deliberately NOT an Output: the deploy engine's
 * `resolveOutputs` is warn-and-continue on resolution failures, so only a
 * resource-property reference makes `cdkd deploy` exit non-zero, which is
 * exactly what verify.sh asserts. The dependency edge (Consumer ->
 * Probe) guarantees Probe is created before the failure fires, so
 * verify.sh also exercises post-failure cleanup.
 */
export class GetattFallbackGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const probe = new ssm.CfnParameter(this, 'Probe', {
      name: `${this.stackName}-param`,
      type: 'String',
      value: 'guard-probe',
    });

    // Low-level cdk.Fn.getAtt so synth does not reject the (deliberately)
    // nonexistent attribute name.
    new ssm.CfnParameter(this, 'Consumer', {
      name: `${this.stackName}-param-consumer`,
      type: 'String',
      value: cdk.Fn.getAtt(probe.logicalId, 'BogusArn').toString(),
    });
  }
}
