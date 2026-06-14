import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * Surfaces bugs in cdkd's UPDATE-time handling of CloudFormation
 * template-level attributes that change BETWEEN deploys — the diff-edge
 * cases that the in-place / replacement provider paths and the
 * DeletionPolicy / UpdateReplacePolicy destroy-skip logic are
 * under-tested for.
 *
 * The two deploys are driven by a CDK context flip (`-c phase=a` then
 * `-c phase=b`), read at synth time so the second deploy synthesizes a
 * mutated template with NO code change. The fixture is cheap (S3 / SSM /
 * SNS — no VPC, no Lambda, no Custom Resources) so each assertion
 * isolates the policy / replacement behavior from unrelated destroy-path
 * code.
 *
 * Four update-edge cases (each asserted across phases by verify.sh):
 *
 *  1. UpdateReplacePolicy: Retain orphan-on-replace (RetainReplaceBucket)
 *     An S3 Bucket with an explicit `bucketName` (whose suffix flips
 *     phase-a -> phase-b) and `RemovalPolicy.RETAIN`. `BucketName` is in
 *     cdkd's replacement-rules registry, so the phase-b name change
 *     FORCES replacement (new physical id). Because `UpdateReplacePolicy`
 *     is `Retain`, the OLD bucket must be LEFT on AWS (not deleted) while
 *     the new one is created. verify.sh asserts the old physical id still
 *     exists AND the new one exists. INTENTIONAL ORPHAN — the trap
 *     deletes the retained old bucket by its captured physical id.
 *
 *  2. DeletionPolicy flip on update (PolicyFlipParam, SSM Parameter)
 *     phase-a: `RemovalPolicy.DESTROY`; phase-b: `RemovalPolicy.RETAIN`.
 *     The value is unchanged, so the only diff between phases is the
 *     `DeletionPolicy` attribute (cdkd schema v5 records it in state).
 *     The FINAL destroy must honor the CURRENT (phase-b = Retain) policy
 *     and leave the parameter on AWS. INTENTIONAL ORPHAN — the trap
 *     deletes it by name.
 *
 *  3. DependsOn add/remove on update (SNS Topics)
 *     - DependsOnAddA / DependsOnAddB: phase-a has NO DependsOn between
 *       them; phase-b ADDS `DependsOnAddB depends on DependsOnAddA`.
 *     - DependsOnRemoveA / DependsOnRemoveB: phase-a HAS
 *       `DependsOnRemoveB depends on DependsOnRemoveA`; phase-b REMOVES
 *       it. Both topics keep their physical ids across the update; the
 *       DependsOn change is metadata only (no property / replacement),
 *       so the update must succeed with the topics intact.
 *
 *  4. Metadata-only / no-op update
 *     Re-deploying the SAME phase a second time (identical template)
 *     must report NO changes (cdkd must not spuriously update /
 *     replace). verify.sh runs an extra identical redeploy after
 *     phase b and greps for "No changes detected".
 *
 * Outputs expose the physical ids verify.sh needs to capture for both
 * assertions and orphan cleanup.
 */
export class UpdatePolicyMutationsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 'a' (default) or 'b'. Read at synth time so the second deploy
    // produces a mutated template with no source change.
    const phase = (this.node.tryGetContext('phase') as string | undefined) ?? 'a';
    const isPhaseB = phase === 'b';

    // ---- Case 1: UpdateReplacePolicy: Retain orphan-on-replace --------
    // BucketName is in cdkd's replacement-rules S3 `replacementProperties`
    // set, so the phase-b suffix flip forces a REPLACEMENT (new physical
    // id). RemovalPolicy.RETAIN makes CDK synth emit BOTH
    // `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`, so the
    // OLD bucket must survive the replace. Name is derived from the
    // stable account+region (globally unique) plus the phase suffix.
    const bucketSuffix = isPhaseB ? 'phase-b' : 'phase-a';
    // covers: AWS::S3::Bucket
    const retainReplaceBucket = new s3.Bucket(this, 'RetainReplaceBucket', {
      bucketName: `cdkd-updpolicy-${this.account}-${this.region}-${bucketSuffix}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    // ---- Case 2: DeletionPolicy flip on update ------------------------
    // phase-a DESTROY -> phase-b RETAIN. The stringValue is identical
    // across phases, so the ONLY diff is the DeletionPolicy attribute.
    // The final destroy (run while phase-b is the current state) must
    // honor Retain and leave the parameter on AWS.
    // covers: AWS::SSM::Parameter
    const policyFlipParam = new ssm.StringParameter(this, 'PolicyFlipParam', {
      parameterName: '/cdkd-integ/update-policy-mutations/policy-flip',
      stringValue: 'value-does-not-change-only-the-deletion-policy-flips',
      description: 'DeletionPolicy flips DESTROY (phase a) -> RETAIN (phase b) between deploys.',
    });
    policyFlipParam.applyRemovalPolicy(
      isPhaseB ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    );

    // ---- Case 3a: DependsOn ADD on update -----------------------------
    // Two SNS Topics with no inter-dependency in phase a; phase b adds
    // `DependsOnAddB depends on DependsOnAddA`. Both keep their physical
    // ids — the update is a metadata-only DependsOn change.
    // covers: AWS::SNS::Topic
    const dependsOnAddA = new sns.Topic(this, 'DependsOnAddA', {
      displayName: 'cdkd updpolicy DependsOn-add A',
    });
    const dependsOnAddB = new sns.Topic(this, 'DependsOnAddB', {
      displayName: 'cdkd updpolicy DependsOn-add B',
    });
    if (isPhaseB) {
      dependsOnAddB.node.addDependency(dependsOnAddA);
    }

    // ---- Case 3b: DependsOn REMOVE on update --------------------------
    // phase a HAS `DependsOnRemoveB depends on DependsOnRemoveA`; phase b
    // removes it. CDK's addDependency cannot be "un-added", so the
    // dependency is only wired in phase a.
    const dependsOnRemoveA = new sns.Topic(this, 'DependsOnRemoveA', {
      displayName: 'cdkd updpolicy DependsOn-remove A',
    });
    const dependsOnRemoveB = new sns.Topic(this, 'DependsOnRemoveB', {
      displayName: 'cdkd updpolicy DependsOn-remove B',
    });
    if (!isPhaseB) {
      dependsOnRemoveB.node.addDependency(dependsOnRemoveA);
    }

    // ---- Case 4: no-op anchor -----------------------------------------
    // A plain SSM Parameter that never changes across phases. Its
    // presence (combined with the identical phase-a redeploy in
    // verify.sh) is what the no-op assertion observes: a phase-a ->
    // phase-a redeploy must report "No changes detected".
    // covers: AWS::SSM::Parameter
    const stableParam = new ssm.StringParameter(this, 'StableParam', {
      parameterName: '/cdkd-integ/update-policy-mutations/stable',
      stringValue: 'this-value-never-changes-between-phases',
      description: 'Unchanged across phases; anchors the no-op redeploy assertion.',
    });
    stableParam.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ---- Outputs (physical ids verify.sh captures) --------------------
    new cdk.CfnOutput(this, 'RetainReplaceBucketName', {
      value: retainReplaceBucket.bucketName,
      description: 'S3 bucket physical name (changes phase a -> b; old must be retained).',
    });
    new cdk.CfnOutput(this, 'PolicyFlipParamName', {
      value: policyFlipParam.parameterName,
      description: 'SSM parameter whose DeletionPolicy flips; final destroy must retain it.',
    });
    new cdk.CfnOutput(this, 'DependsOnAddBArn', {
      value: dependsOnAddB.topicArn,
      description: 'SNS topic that gains a DependsOn in phase b.',
    });
    new cdk.CfnOutput(this, 'DependsOnRemoveBArn', {
      value: dependsOnRemoveB.topicArn,
      description: 'SNS topic that loses a DependsOn in phase b.',
    });
    new cdk.CfnOutput(this, 'StableParamName', {
      value: stableParam.parameterName,
      description: 'Unchanged SSM parameter anchoring the no-op assertion.',
    });
  }
}
