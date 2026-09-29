import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * Fixture for `cdkd rollback` re-creating an EXPLICITLY named IAM Role under
 * the name its deploy sent (issue #4018), and for the rewritten-name holder
 * refusal (issue #4010) on that re-create.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::SQS::Queue
 *
 * The IAM Role provider sends `generateResourceNameWithFallback(RoleName)`,
 * which prepends the stack name unless the deploy's user-supplied-name prefix
 * flag says to skip it (the default). The deploy records that flag in its
 * rollback-journal segment, and `cdkd rollback` must replay under it.
 *
 * Env-parameterized so verify.sh drives every phase from ONE app (the
 * `rollback-sqs-cooldown` pattern):
 *
 *   - `NamedRole` — `roleName: cdkd-integ-rbrw-<ROLE_SUFFIX>` (default `a`).
 *     Changing the suffix changes the create-only `RoleName`, driving a
 *     REPLACEMENT (new role created, old one deleted).
 *     `ROLE_DESCRIPTION_V2=true` changes only the mutable `Description`, an
 *     in-place UPDATE whose revert must stay in place.
 *   - `FailingQueue` — an SQS queue with an out-of-range
 *     `messageRetentionPeriod`, added ONLY when `INJECT_FAIL=true`. AWS
 *     rejects `CreateQueue`, so the deploy fails deterministically. It DEPENDS
 *     ON `NamedRole` so the replacement completes first and the journal
 *     records it.
 */
export class RollbackExplicitNameRewriteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-explicit-name-rewrite');

    const suffix = process.env.ROLE_SUFFIX ?? 'a';
    const role = new iam.CfnRole(this, 'NamedRole', {
      roleName: `cdkd-integ-rbrw-${suffix}`,
      description:
        'cdkd-integ rollback-explicit-name-rewrite subject' +
        (process.env.ROLE_DESCRIPTION_V2 === 'true' ? ' v2' : ''),
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.addDependency(role);
    }
  }
}
