import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * go-to-k/cdkd#4606, the CloudWatch Logs log group arm: a fix-forward deploy
 * deletes the log group a failed CREATE left in AWS, and keeps one whose name
 * was re-used.
 *
 * - The baseline holds `BaseLogGroup`.
 * - `WITH_ORPHANS=true` adds `OrphanA` and `OrphanC`, each with a retention.
 *   verify.sh deploys that template as a role that may create and read a log
 *   group but may neither put a retention policy nor delete a log group. So
 *   each CREATE makes the log group, fails on the post-create
 *   `PutRetentionPolicy`, and cannot clean up: the journal records each as a
 *   proven orphan with the identity the engine reads for it when it journals
 *   the failure (`<logGroupArn>@<creationTime>`).
 * - `ORPHAN_FIX_FORWARD=true` keeps both orphan logical ids under another name
 *   (`-b`), so the fix-forward deploy creates two new log groups. Before it,
 *   verify.sh deletes `OrphanC`'s log group and re-creates the name itself
 *   (made outside the stack, at another creation time): the fix-forward must
 *   delete `OrphanA`'s and keep that one.
 *
 * L1 resources with explicit names, using only properties the Logs SDK
 * provider handles, so every one stays on the SDK route (`provisionedBy:
 * sdk`), where `isSameResource` / `resourceIdentity` live. `cdkd-lgffo-a`
 * prefixes `cdkd-lgffo-a-b` on purpose: the provider's prefix reads must pick
 * out the exact name.
 */
export class LogsLogGroupFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new logs.CfnLogGroup(this, 'BaseLogGroup', { logGroupName: 'cdkd-lgffo-base' });

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      new logs.CfnLogGroup(this, 'OrphanA', {
        logGroupName: `cdkd-lgffo-a${suffix}`,
        retentionInDays: 7,
      });
      new logs.CfnLogGroup(this, 'OrphanC', {
        logGroupName: `cdkd-lgffo-c${suffix}`,
        retentionInDays: 7,
      });
    }
  }
}
