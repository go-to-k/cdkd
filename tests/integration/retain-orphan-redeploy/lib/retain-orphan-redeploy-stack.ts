import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Retain-orphan-redeploy integ stack (issue #2902).
 *
 * The reported loop, reduced to the smallest shape that reproduces it: a
 * resource whose physical name cdkd GENERATES, of a type that REFUSES a
 * colliding create.
 *
 * Both properties are load-bearing and neither is incidental:
 *
 *   - No `roleName`, so `generateResourceName` derives
 *     `{stackName}-{logicalId}` with no random component. A template-named
 *     resource would not exercise the diagnosis at all, because the advice
 *     deliberately refuses a name cdkd did not derive.
 *   - `AWS::IAM::Role`, because it answers a duplicate name with
 *     `EntityAlreadyExists`. Several types do NOT: `AWS::S3::Bucket`,
 *     `AWS::Logs::LogGroup` and `AWS::SNS::Topic` silently ADOPT an existing
 *     resource, so a fixture built on one of those would redeploy green and
 *     assert nothing — the failure mode this fixture exists to catch.
 *
 * The role is deliberately trivial (an assumable principal, no policies): the
 * subject under test is cdkd's naming and its recovery advice, not IAM.
 *
 * `RemovalPolicy.DESTROY` is explicit. The ORPHAN this fixture needs is
 * manufactured by `cdkd state orphan`, which drops the state record and leaves
 * AWS untouched — the same end state a `DeletionPolicy: Retain` rollback
 * produces, reached deterministically instead of by injecting a failure whose
 * timing decides what got created. Retain here would only leak the role.
 */
export class RetainOrphanRedeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, 'OrphanedRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Resource whose cdkd-generated name the redeploy collides with',
    });
    role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'RoleName', { value: role.roleName });
  }
}

/**
 * The ADOPTION arm (issue #2934).
 *
 * The arm above manufactures its orphan with `cdkd state orphan`, which drops
 * the state record and writes NO orphan record — so it exercises the
 * go-to-k/cdkd#2916 diagnosis, which is still the fallback when cdkd holds no
 * evidence. This one produces the orphan the way a USER does, and that
 * difference is the whole point: only a real rollback mints the record the
 * adoption reads.
 *
 * Two modes, driven by `CDKD_TEST_ADOPT`:
 *
 *   - `fail`  — a `Retain` role PLUS a queue whose `MessageRetentionPeriod` is
 *     out of range. The queue's CREATE fails, the deploy rolls back, and the
 *     role survives under `DeletionPolicy: Retain` with a record naming it.
 *     The role must be created BEFORE the queue fails, which `dependsOn`
 *     guarantees — without it the DAG may fail the queue first and the role is
 *     never created, so the run would pass while proving nothing.
 *   - `fixed` — the same role, queue repaired. This is the redeploy that must
 *     succeed by ADOPTING the orphaned role rather than colliding with it.
 *
 * The role carries RETAIN here (the arm above uses DESTROY) because that is
 * the policy under test: it is what makes the rollback orphan rather than
 * delete. The fixture's teardown deletes it by name, so it does not leak.
 */
export class RetainOrphanAdoptStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env['CDKD_TEST_ADOPT'] ?? 'fixed';

    const role = new iam.Role(this, 'AdoptedRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Retain resource the rollback orphans and the next deploy re-adopts',
    });
    role.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    // 60 s is legal; 1 s is not (SQS accepts 60..1_209_600). Declared as an L1
    // so the invalid value reaches AWS instead of being rejected at synth.
    const queue = new sqs.CfnQueue(this, 'Gate', {
      messageRetentionPeriod: mode === 'fail' ? 1 : 60,
    });
    // Ordering, not decoration: the role must EXIST before the queue fails, or
    // the rollback has nothing to orphan and the fixture asserts nothing.
    queue.node.addDependency(role);

    new cdk.CfnOutput(this, 'AdoptedRoleName', { value: role.roleName });
  }
}
