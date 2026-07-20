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
 *
 * Phase toggle (issue #1111): `GUARD_PHASE=warn` switches the bogus
 * attribute to `BogusName` — a non-Arn/-Url suffix that DEFAULT mode
 * warn-passes (falls back to the physical id, surfacing the deploy-summary
 * fallback line) while `--strict-getatt` hard-fails it. The default phase
 * (unset / anything else) keeps the always-fatal `BogusArn` shape.
 *
 * `GUARD_PHASE=output-strict` (issue #1111 review blocker): every RESOURCE
 * property is valid (the Consumer holds a literal value) and the ONLY bogus
 * GetAtt lives in a stack Output. Under `--strict-getatt` the output
 * failure fires AFTER all resources were provisioned, so the deploy must
 * exit non-zero AND still persist state recording the created resources —
 * verify.sh asserts the state file exists and `cdkd destroy` cleans up
 * (proving no invisible orphans on a FIRST deploy, where the incremental
 * per-resource saves are no-ops).
 */
export class GetattFallbackGuardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.GUARD_PHASE;
    const bogusAttribute = phase === 'warn' ? 'BogusName' : 'BogusArn';

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
      value:
        phase === 'output-strict'
          ? 'guard-consumer-literal'
          : cdk.Fn.getAtt(probe.logicalId, bogusAttribute).toString(),
    });

    if (phase === 'output-strict') {
      new cdk.CfnOutput(this, 'BadOutput', {
        value: cdk.Fn.getAtt(probe.logicalId, 'BogusName').toString(),
      });
    }
  }
}
