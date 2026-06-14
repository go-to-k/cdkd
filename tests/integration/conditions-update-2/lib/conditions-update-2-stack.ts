import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Harder CloudFormation-Conditions-on-UPDATE stress fixture for cdkd.
 *
 * The sibling `conditions-and-if` fixture surfaced bug #840 (a resource whose
 * `Condition:` flips true -> false on redeploy was never deleted). The #840
 * fix (`TemplateParser.filterResourcesByCondition`) prunes condition-false
 * resources from the effective template before the diff. This fixture goes
 * AFTER the sibling condition-on-UPDATE semantics that the narrow flip case
 * does NOT exercise, each of which is a distinct way the prune step can still
 * be wrong:
 *
 *   1. Resource MOVES conditions on update. `MoverParam` is gated on
 *      `IsPhaseA` (true in phase a) then re-gated on `IsPhaseB` (false in
 *      phase b) — so it must be DELETED. `AppearParam` is the reverse: gated
 *      on `IsPhaseB`, so absent in phase a and CREATED in phase b. (#840
 *      proved the flip-to-false DELETE; the moved-condition + absent->present
 *      pair widens it to "the resource set is recomputed correctly when a
 *      resource's gating condition changes identity, not just its value".)
 *
 *   2. `Fn::If` -> `AWS::NoValue` removing a NESTED property block on an
 *      IN-PLACE UPDATE. `WorkQueue` (always present) carries a `RedrivePolicy`
 *      JSON block in phase a and `AWS::NoValue` in phase b. The queue is NOT
 *      replaced (same physical id), so this exercises the provider.update()
 *      path dropping a whole nested block — not just the create-time omission
 *      the sibling fixture's SNS DisplayName covered.
 *
 *   3. Condition-gated OUTPUT. `MoverParamName` output is gated on `IsPhaseA`
 *      so it is present in cdkd state outputs in phase a and absent in phase
 *      b. Asserted by reading the cdkd state file outputs map directly.
 *
 *   4. `DependsOn` referencing a condition-EXCLUDED resource. `KeeperParam`
 *      (always present) `DependsOn` `MoverParam`, which is condition-false in
 *      phase b. cdkd must DROP the dangling DependsOn (like CloudFormation)
 *      rather than choke on it — `KeeperParam` must still deploy in phase b.
 *
 *   5. `Ref` to a condition-excluded resource INSIDE a condition-false
 *      resource (both excluded together). `RefHolderParam` (gated on
 *      `IsPhaseA`) has a Value that `Ref`s `MoverParam` (also gated on
 *      `IsPhaseA`). In phase b BOTH are pruned, so the surviving template has
 *      no dangling Ref — assert no dangling-ref crash on the phase-b deploy.
 *
 * Drive: a `Phase` CfnParameter Default is sourced from CDK context
 * (`-c phase=a|b`) at synth time, mirroring the sibling fixture (cdkd has no
 * deploy-time --parameter flag; parameters resolve from the template Default).
 * Flipping `-c phase=...` between two `cdkd deploy` runs flips every condition.
 *
 * Cheap: 4x SSM Parameter + 2x SQS Queue, no VPC / NAT.
 */
export class ConditionsUpdate2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phaseFromContext = (this.node.tryGetContext('phase') as string) ?? 'a';

    const phaseParam = new cdk.CfnParameter(this, 'Phase', {
      type: 'String',
      default: phaseFromContext,
      allowedValues: ['a', 'b'],
      description: 'Deploy phase — drives every condition in this stack',
    });

    // ---- Conditions section ------------------------------------------
    const isPhaseA = new cdk.CfnCondition(this, 'IsPhaseA', {
      expression: cdk.Fn.conditionEquals(phaseParam.valueAsString, 'a'),
    });
    // Fn::Not over IsPhaseA — phase b. (Not a bare Equals, so the prune step
    // is exercised against a derived condition, not just a primitive one.)
    const isPhaseB = new cdk.CfnCondition(this, 'IsPhaseB', {
      expression: cdk.Fn.conditionNot(isPhaseA),
    });

    // ---- Case 1a: resource MOVES conditions (present a -> absent b) ---
    // Gated on IsPhaseA: created in phase a, condition-false in phase b ->
    // must be DELETED. Also the target of case 4's DependsOn + case 5's Ref.
    const moverParam = new ssm.CfnParameter(this, 'MoverParam', {
      type: 'String',
      name: `/cdkd-conditions-update-2/${this.account}/mover`,
      value: 'present-in-phase-a',
      description: 'Gated on IsPhaseA; DELETED when phase flips to b',
    });
    moverParam.cfnOptions.condition = isPhaseA;

    // ---- Case 1b: reverse — absent a -> present b --------------------
    // Gated on IsPhaseB: absent in phase a, CREATED on the phase-b redeploy.
    const appearParam = new ssm.CfnParameter(this, 'AppearParam', {
      type: 'String',
      name: `/cdkd-conditions-update-2/${this.account}/appear`,
      value: 'appears-in-phase-b',
      description: 'Gated on IsPhaseB; CREATED when phase flips to b',
    });
    appearParam.cfnOptions.condition = isPhaseB;

    // ---- Case 4: always-present resource that DependsOn a -------------
    // condition-excluded resource. In phase b, MoverParam is pruned, so this
    // DependsOn dangles — cdkd must drop it and still deploy KeeperParam.
    const keeperParam = new ssm.CfnParameter(this, 'KeeperParam', {
      type: 'String',
      name: `/cdkd-conditions-update-2/${this.account}/keeper`,
      // The value is itself phase-dependent via Fn::If so the in-place UPDATE
      // path runs on the phase-b redeploy (proves KeeperParam survives AND
      // updates even though its DependsOn target vanished).
      value: cdk.Fn.conditionIf(isPhaseA.logicalId, 'keeper-phase-a', 'keeper-phase-b').toString(),
      description: 'Always present; DependsOn the condition-gated MoverParam',
    });
    // Explicit DependsOn on a resource that is condition-false in phase b.
    keeperParam.addDependency(moverParam);

    // ---- Case 5: Ref to a condition-excluded resource INSIDE a --------
    // condition-false resource (both pruned together in phase b).
    // RefHolderParam is gated on IsPhaseA and its Value Refs MoverParam (also
    // gated on IsPhaseA). In phase b BOTH are removed, so no dangling Ref
    // survives — assert the phase-b deploy does not crash on a dangling ref.
    const refHolderParam = new ssm.CfnParameter(this, 'RefHolderParam', {
      type: 'String',
      name: `/cdkd-conditions-update-2/${this.account}/ref-holder`,
      // Ref MoverParam's name (its physical id). Both share IsPhaseA.
      value: moverParam.ref,
      description: 'Gated on IsPhaseA; Refs the also-gated MoverParam',
    });
    refHolderParam.cfnOptions.condition = isPhaseA;

    // ---- Case 2: Fn::If -> AWS::NoValue removing a NESTED property ----
    // block on an IN-PLACE UPDATE. WorkQueue is always present; its
    // RedrivePolicy (a nested JSON block pointing at the DLQ) is SET in phase
    // a and OMITTED (AWS::NoValue) in phase b. Same physical id across the
    // update, so this is the provider.update() drop-a-nested-block path.
    const deadLetterQueue = new sqs.CfnQueue(this, 'DeadLetterQueue', {
      queueName: `cdkd-conditions-update-2-dlq-${this.account}`,
      messageRetentionPeriod: 1209600,
    });

    const workQueue = new sqs.CfnQueue(this, 'WorkQueue', {
      queueName: `cdkd-conditions-update-2-work-${this.account}`,
      // RedrivePolicy present in phase a, AWS::NoValue (omitted) in phase b.
      redrivePolicy: cdk.Fn.conditionIf(
        isPhaseA.logicalId,
        {
          deadLetterTargetArn: deadLetterQueue.attrArn,
          maxReceiveCount: 3,
        },
        cdk.Aws.NO_VALUE
      ),
    });

    // ---- Case 3: condition-gated OUTPUT ------------------------------
    // Present in cdkd state outputs in phase a, absent in phase b.
    const moverOutput = new cdk.CfnOutput(this, 'MoverParamName', {
      value: cdk.Fn.conditionIf(
        isPhaseA.logicalId,
        moverParam.ref,
        cdk.Aws.NO_VALUE
      ).toString(),
      description: 'Name of MoverParam (output gated on IsPhaseA)',
    });
    moverOutput.condition = isPhaseA;

    // ---- Always-present output for queue ARN assertions --------------
    new cdk.CfnOutput(this, 'WorkQueueUrl', {
      value: workQueue.ref,
      description: 'URL of the always-present work queue',
    });

    new cdk.CfnOutput(this, 'KeeperParamName', {
      value: keeperParam.ref,
      description: 'Name of the always-present keeper SSM parameter',
    });
  }
}
