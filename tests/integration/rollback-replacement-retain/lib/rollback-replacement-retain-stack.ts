import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Fixture for issue #2598 — on a replacement rollback,
 * `UpdateReplacePolicy: Retain` governs the fate of the replacement's NEW
 * physical copy, and `DeletionPolicy` does not.
 *
 * covers: AWS::SSM::Parameter
 *
 * THREE parameters, one per row of the live CloudFormation A/B this behaviour
 * was measured against (us-east-1, 2026-09-05: a forced `AWS::SSM::Parameter`
 * replacement plus a deterministically failing sibling, rolled back):
 *
 * | logical id            | DeletionPolicy | UpdateReplacePolicy | new copy |
 * | --------------------- | -------------- | ------------------- | -------- |
 * | `ControlParam`        | (none)         | (none)              | DELETED  |
 * | `DeletionPolicyParam` | Retain         | (none)              | DELETED  |
 * | `RetainParam`         | (none)         | Retain              | SURVIVED |
 *
 * `RetainParam` is the polarity under test; the other two are the controls
 * that stop the fixture from passing for a cdkd that simply never deletes
 * anything on this path. `DeletionPolicyParam` is the sharper of the two: it
 * is the row that refutes "DeletionPolicy governs it", so a future edit that
 * pointed `rollbackRetainsNewResource` at `deletionPolicy` would still pass a
 * plain no-policy control and fails here.
 *
 * WHY `AWS::SSM::Parameter`
 *
 * `Name` is create-only (`replacement-rules.ts`), so flipping it forces a
 * property-driven replacement; the type has an SDK provider; a parameter name
 * is released the instant it is deleted, so the control arm's re-create of the
 * OLD name cannot be flaky the way a re-acquired SQS queue name (~60s cooldown)
 * or a globally unique S3 bucket name is; and parameters are free, so the
 * deliberate `Retain` survivor costs nothing while it is alive.
 *
 * `AWS::SSM::Parameter` IS in `STATEFUL_TYPES`, so the two control arms need
 * `--force-stateful-recreation` on the failing deploy. `RetainParam` does not
 * (a `Retain` UpdateReplacePolicy exempts the stateful guard — the old copy
 * survives, so there is no data loss to consent to), but the flag is passed
 * once for the whole deploy and changes nothing on its arm.
 *
 * Env knobs, all driven by verify.sh:
 *
 * - `RETAIN_PARAM_NAME` / `CONTROL_PARAM_NAME` / `DELETION_POLICY_PARAM_NAME`
 *   carry the per-phase parameter names. verify.sh owns the names outright so
 *   the assertions and the template can never drift apart; the defaults here
 *   exist only so a bare `cdkd synth` works.
 * - `ROLLBACK_RETAIN_INTEG_FAIL=true` adds an SQS queue with an out-of-range
 *   `MessageRetentionPeriod` that AWS rejects deterministically. It DependsOn
 *   all three parameters, so every replacement has COMPLETED when the failure
 *   fires and the rollback classifies each of them as a replacement rather
 *   than a plain CREATE.
 */
export class RollbackReplacementRetainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const base = '/cdkd-integ/rollback-replacement-retain';
    const retainName = process.env['RETAIN_PARAM_NAME'] ?? `${base}/retain-v1`;
    const controlName = process.env['CONTROL_PARAM_NAME'] ?? `${base}/control-v1`;
    const deletionPolicyName =
      process.env['DELETION_POLICY_PARAM_NAME'] ?? `${base}/deletion-policy-v1`;

    // L1 throughout: the attributes under test are `cfnOptions`, and the
    // assertions read the recorded property bag, so the template has to say
    // exactly what this file says and nothing an L2 might add on its behalf.
    //
    // The VALUE is identical on both phases on purpose. `Name` is the only
    // thing that changes between v1 and v2, so the replacement is
    // unambiguously property-driven on the create-only key.
    const retain = new ssm.CfnParameter(this, 'RetainParam', {
      name: retainName,
      type: 'String',
      value: 'cdkd-rollback-replacement-retain',
      description: 'issue #2598: UpdateReplacePolicy Retain, no DeletionPolicy',
    });
    // `cfnOptions` rather than `applyRemovalPolicy(RETAIN)`: the latter sets
    // BOTH DeletionPolicy and UpdateReplacePolicy, which would collapse this
    // arm into the `DeletionPolicyParam` one and destroy the discrimination
    // the fixture exists to make. No DeletionPolicy here is equally
    // load-bearing — it is what lets `cdkd destroy` remove the RE-ADOPTED old
    // copy in the final phase, so the surviving new copy is the only thing
    // left standing.
    retain.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

    // Control 1: no policy at all. The default polarity — the rollback must
    // still DELETE the new copy.
    const control = new ssm.CfnParameter(this, 'ControlParam', {
      name: controlName,
      type: 'String',
      value: 'cdkd-rollback-replacement-retain',
      description: 'issue #2598 control: no DeletionPolicy, no UpdateReplacePolicy',
    });

    // Control 2: DeletionPolicy Retain and NOTHING else. The A/B row that
    // refutes "DeletionPolicy governs the new copy" — the rollback must delete
    // the new copy here too. Its OLD copy is deliberately left behind by
    // `cdkd destroy` (that IS DeletionPolicy: Retain working); verify.sh
    // deletes it as a test artifact, exactly as the snapshot fixture deletes
    // its final snapshot.
    const deletionPolicy = new ssm.CfnParameter(this, 'DeletionPolicyParam', {
      name: deletionPolicyName,
      type: 'String',
      value: 'cdkd-rollback-replacement-retain',
      description: 'issue #2598 control: DeletionPolicy Retain, no UpdateReplacePolicy',
    });
    deletionPolicy.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;

    if (process.env['ROLLBACK_RETAIN_INTEG_FAIL'] === 'true') {
      // MessageRetentionPeriod's ceiling is 1209600 (14 days); this is well
      // past it, so CreateQueue is rejected and the deploy rolls back. The
      // queue is never created, so it consumes no queue name and cannot ride
      // the SQS same-name deletion cooldown on a re-run.
      const failing = new sqs.CfnQueue(this, 'FailQueue', {
        messageRetentionPeriod: 999999999,
      });
      failing.addDependency(retain);
      failing.addDependency(control);
      failing.addDependency(deletionPolicy);
    }
  }
}
