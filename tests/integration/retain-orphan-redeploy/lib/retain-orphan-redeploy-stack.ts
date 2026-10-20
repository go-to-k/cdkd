import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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
 *     `{stackName}-{logicalId}-{12 hex}`, the suffix hashing the stack
 *     instance id, the logical id and the name generation (go-to-k/cdkd#5064).
 *     A template-named resource would not exercise the diagnosis at all,
 *     because the advice deliberately refuses a name cdkd did not derive.
 *     Since the orphan's generation is retired, the redeploy derives the NEXT
 *     generation's name; verify.sh plants a holder on that name.
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
 * the state record and writes NO orphan record, and exercises the
 * go-to-k/cdkd#2916 diagnosis. This one produces the orphan the way a USER
 * does: only a real rollback mints the orphan record. #2934 adopted that
 * record's resource back; on a stack with a stack instance id
 * (go-to-k/cdkd#5064) the rollback retires its name generation instead, so the
 * redeploy creates a new role under the next generation's name and warns
 * that the orphan is not taken back.
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
 *     succeed by creating a NEW role beside the orphaned one rather than
 *     colliding with it or taking it back.
 *
 * The role carries RETAIN here (the arm above uses DESTROY) because that is
 * the policy under test: it is what makes the rollback orphan rather than
 * delete. The fixture's teardown deletes it by name, so it does not leak.
 *
 * `fixed` also declares `KeptTopic`, an un-named RETAIN topic (go-to-k/cdkd#5064).
 * The destroy records it and the RETAIN role in the stack's `retained.json`
 * (every kept resource under a generated name). The redeploy after that destroy is a new
 * stack lifetime: verify.sh asserts it creates a NEW topic under a new name
 * rather than taking the kept one back, and warns once naming `cdkd import`.
 * Absent from `fail`, so the rollback still orphans exactly one resource.
 */
export class RetainOrphanAdoptStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env['CDKD_TEST_ADOPT'] ?? 'fixed';

    const role = new iam.Role(this, 'AdoptedRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Retain resource the rollback orphans and the next deploy leaves alone',
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

    if (mode === 'fixed') {
      const kept = new sns.CfnTopic(this, 'KeptTopic', {});
      kept.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }

    new cdk.CfnOutput(this, 'AdoptedRoleName', { value: role.roleName });
  }
}

/**
 * The SINGLE-RECORD orphan arm (go-to-k/cdkd#4602): `cdkd state orphan <stack>
 * --resource <logicalId>`.
 *
 * Two modes, driven by `CDKD_TEST_ORPHAN_RESOURCE`:
 *
 *   - `with` (default) -- a queue, and a parameter whose value is the queue's
 *     URL, so the parameter's record DEPENDS on the queue. That dependency is
 *     what the orphan must rewrite out of the surviving record.
 *   - `without` -- the queue has LEFT the template, the case the option exists
 *     for (a resource whose construct is gone, which `cdkd orphan` cannot
 *     address). The parameter keeps its logical id with a literal value, so the
 *     redeploy also exercises an ordinary UPDATE of the surviving record.
 *
 * Both resources take `RemovalPolicy.DESTROY`: the queue is orphaned on
 * purpose and deleted by `verify.sh` by URL, and the parameter is destroyed
 * with the stack.
 */
export class RetainOrphanResourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env['CDKD_TEST_ORPHAN_RESOURCE'] ?? 'with';

    let value = 'detached';
    if (mode === 'with') {
      const queue = new sqs.Queue(this, 'DetachedQueue', {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      value = queue.queueUrl;
      new cdk.CfnOutput(this, 'DetachedQueueName', { value: queue.queueName });
    }

    const keeper = new ssm.StringParameter(this, 'Keeper', { stringValue: value });
    keeper.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  }
}
