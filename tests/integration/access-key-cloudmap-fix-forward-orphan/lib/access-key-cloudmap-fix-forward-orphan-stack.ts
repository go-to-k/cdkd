import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

/**
 * go-to-k/cdkd#4606, the IAM access key and Cloud Map service arm: a
 * fix-forward deploy deletes the access key or Cloud Map service a failed
 * CREATE left in AWS, once a live read (`isSameResource`) proves it is not the
 * one the new state record holds. Both physical ids are AWS-generated
 * (`AKIA…`, `srv-…`), so no recorded identity is needed.
 *
 * - The baseline holds `BaseUser` and `BaseNamespace` (an HTTP namespace).
 * - `WITH_ORPHANS=true` adds `KeyA` (an access key on `BaseUser`, `Status:
 *   Inactive`) and `ServiceA` (a service in `BaseNamespace` with
 *   `ServiceAttributes`). verify.sh deploys that template as a role that may
 *   create an access key or a service but may neither update an access key,
 *   set service attributes, nor delete either. So each CREATE makes its
 *   resource, fails on the post-create `UpdateAccessKey` /
 *   `UpdateServiceAttributes`, and cannot clean up: the journal records each
 *   as a proven orphan.
 * - `ORPHAN_FIX_FORWARD=true` keeps both logical ids (the key `Active`, the
 *   service under another name, `-b`), so the fix-forward deploy creates two
 *   new resources under them, and must delete the two earlier ones.
 *
 * L1 resources with explicit names, using only properties the SDK providers
 * handle, so every one stays on the SDK route (`provisionedBy: sdk`), where
 * `isSameResource` lives.
 */
export class AccessKeyCloudMapFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const baseUser = new iam.CfnUser(this, 'BaseUser', { userName: 'cdkd-akcfo-base-user' });
    const baseNamespace = new servicediscovery.CfnHttpNamespace(this, 'BaseNamespace', {
      name: 'cdkd-akcfo-ns',
    });

    if (process.env.WITH_ORPHANS === 'true') {
      const fixForward = process.env.ORPHAN_FIX_FORWARD === 'true';
      new iam.CfnAccessKey(this, 'KeyA', {
        userName: baseUser.ref,
        status: fixForward ? 'Active' : 'Inactive',
      });
      new servicediscovery.CfnService(this, 'ServiceA', {
        name: `cdkd-akcfo-svc-a${fixForward ? '-b' : ''}`,
        namespaceId: baseNamespace.attrId,
        serviceAttributes: { 'cdkd-akcfo': 'fix-forward-orphan' },
      });
    }
  }
}
