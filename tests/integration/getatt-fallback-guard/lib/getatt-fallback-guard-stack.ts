import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Error-path fixture for the Fn::GetAtt unknown-attribute ARN-shape guard
 * (issue #1106). covers: AWS::SSM::Parameter
 *
 * `AWS::SSM::Parameter` has NO per-type handler in the resolver's
 * `constructAttribute` switch, and its SDK provider stores
 * `{Type, Value, Arn}` in `attributes` with the parameter NAME as the
 * physicalId — so `Fn::GetAtt [Probe, BogusArn]` reaches the final
 * unknown-attribute fallback, where the physicalId is not ARN-shaped and
 * the deploy must now HARD-FAIL with an actionable error instead of
 * shipping the wrong value with a warning (the #1103 incident class).
 * (`Arn` joined that map in issue 1824; it is a KNOWN attribute, so it
 * never reaches the fallback and the guard phases are unaffected. The
 * `arn-resolves` phase below is the positive half of the same behavior.)
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
 * `GUARD_PHASE=arn-resolves` / `arn-resolves-update` (issue 1824): the
 * POSITIVE phase. The Consumer's Value is `Fn::GetAtt [Probe, Arn]` — a
 * REAL attribute, which the provider now caches, so the deploy must
 * SUCCEED and the consumer's live value must equal the probe parameter's
 * live ARN byte for byte.
 *
 * The ARN is CONSTRUCTED (`PutParameter` reports none), so construction
 * and any unit assertion share one formula and a green mocked suite would
 * agree with a wrong wire assumption. Only a real-AWS comparison against
 * `GetParameter`'s `Parameter.ARN` settles it — which is why this phase
 * exists at all.
 *
 * TWO probes, deliberately: a FLAT name (`<stack>-param`, the pre-existing
 * Probe) and a HIERARCHICAL one (leading `/`). The builder folds a leading
 * slash into the ARN's `parameter/` separator, and that fold is exactly
 * where a constructed ARN goes wrong — the other phases only ever use a
 * flat name, so the hierarchical arm would otherwise be untested against
 * real AWS.
 *
 * `arn-resolves-update` is the same shape with the probes' VALUES changed,
 * so the second deploy UPDATEs each Probe. Its point is the update path's
 * attribute REPLACE semantics: `update()` must re-report `Arn` or the
 * create-time value is wiped from the state record. verify.sh reads
 * `attributes.Arn` out of the real persisted state.json before and after.
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
    // BOTH `arn-resolves` phases keep the same resource set — the second only
    // changes the probes' VALUES. Gating the hierarchical pair on the phase set
    // (this OR, matching EVERY later phase that must keep the resources) rather
    // than on the single token that introduced them is what stops the update
    // phase from DELETING resources the previous phase created (the
    // mode-gated-drop trap): a phase value that matches neither arm removes the
    // resource from the template and cdkd correctly issues a DELETE for it. Add
    // any further `arn-resolves-*` phase to this OR for the same reason.
    const arnResolves = phase === 'arn-resolves' || phase === 'arn-resolves-update';
    const probeValue = phase === 'arn-resolves-update' ? 'guard-probe-updated' : 'guard-probe';

    const probe = new ssm.CfnParameter(this, 'Probe', {
      name: `${this.stackName}-param`,
      type: 'String',
      value: probeValue,
    });

    // Low-level cdk.Fn.getAtt so synth does not reject the (deliberately)
    // nonexistent attribute name.
    new ssm.CfnParameter(this, 'Consumer', {
      name: `${this.stackName}-param-consumer`,
      type: 'String',
      value:
        phase === 'output-strict'
          ? 'guard-consumer-literal'
          : arnResolves
            ? // The POSITIVE case: a real, now-cached attribute. Its value is
              // asserted against the live `GetParameter` ARN in verify.sh.
              cdk.Fn.getAtt(probe.logicalId, 'Arn').toString()
            : cdk.Fn.getAtt(probe.logicalId, bogusAttribute).toString(),
    });

    if (arnResolves) {
      // HIERARCHICAL probe: the leading `/` is folded into the ARN's
      // `parameter/` separator, so a naive construction emits a double slash.
      // The flat pair above cannot exercise that branch.
      const hierProbe = new ssm.CfnParameter(this, 'HierProbe', {
        name: `/${this.stackName}/hier/probe`,
        type: 'String',
        value: probeValue,
      });
      new ssm.CfnParameter(this, 'HierConsumer', {
        name: `/${this.stackName}/hier/consumer`,
        type: 'String',
        value: cdk.Fn.getAtt(hierProbe.logicalId, 'Arn').toString(),
      });
    }

    if (phase === 'output-strict') {
      new cdk.CfnOutput(this, 'BadOutput', {
        value: cdk.Fn.getAtt(probe.logicalId, 'BogusName').toString(),
      });
    }
  }
}
