import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pipes from 'aws-cdk-lib/aws-pipes';
import * as sqs from 'aws-cdk-lib/aws-sqs';

/**
 * go-to-k/cdkd#4606, the EventBridge Pipes arm: a fix-forward deploy deletes
 * the pipe a failed CREATE left in AWS, and keeps one whose name was re-used.
 *
 * - The baseline holds the source and target queues, the pipes' execution
 *   role and `BasePipe`.
 * - `WITH_ORPHANS=true` adds `OrphanA` and `OrphanC`. verify.sh deploys that
 *   template as a role that may create a pipe but may neither describe nor
 *   delete one. So each CREATE makes the pipe, fails its settle wait (the
 *   `DescribePipe` is refused) and cannot clean up: the journal records each
 *   as a proven orphan with the identity its mark carries from `CreatePipe`'s
 *   answer (`<pipeArn>@<creationTime epoch seconds>`).
 * - `ORPHAN_FIX_FORWARD=true` keeps both orphan logical ids under another name
 *   (`-b`), so the fix-forward deploy creates two new pipes. Before it,
 *   verify.sh deletes `OrphanC`'s pipe and re-creates the name itself (made
 *   outside the stack, at another creation time): the fix-forward must delete
 *   `OrphanA`'s and keep that one.
 *
 * Every pipe is `STOPPED`, so none polls the source queue (nothing is sent to
 * it either). L1 resources with explicit names, using only properties the
 * Pipes SDK provider handles, so every pipe stays on the SDK route
 * (`provisionedBy: sdk`), where `isSameResource` / `resourceIdentity` live.
 * The role's policy is inline (`Policies`), so it exists before any pipe
 * that names the role.
 */
export class PipesFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const source = new sqs.CfnQueue(this, 'Source', { queueName: 'cdkd-pffo-src' });
    const target = new sqs.CfnQueue(this, 'Target', { queueName: 'cdkd-pffo-tgt' });
    const role = new iam.CfnRole(this, 'PipeRole', {
      roleName: 'cdkd-pffo-pipe-role',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'pipes.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'aws:SourceAccount': this.account } },
          },
        ],
      },
      policies: [
        {
          policyName: 'source-and-target',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
                Resource: source.attrArn,
              },
              { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: target.attrArn },
            ],
          },
        },
      ],
    });

    const pipe = (logicalId: string, name: string): void => {
      new pipes.CfnPipe(this, logicalId, {
        name,
        roleArn: role.attrArn,
        source: source.attrArn,
        target: target.attrArn,
        desiredState: 'STOPPED',
      });
    };

    pipe('BasePipe', 'cdkd-pffo-base');

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      pipe('OrphanA', `cdkd-pffo-a${suffix}`);
      pipe('OrphanC', `cdkd-pffo-c${suffix}`);
    }
  }
}
