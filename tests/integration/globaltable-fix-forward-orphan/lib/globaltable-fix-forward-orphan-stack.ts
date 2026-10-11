import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * go-to-k/cdkd#4606, the DynamoDB global table arm: a fix-forward deploy
 * deletes the global table a failed CREATE left in AWS, and keeps one whose
 * name was re-used.
 *
 * - The baseline holds `BaseTable` alone (a stack needs a resource).
 * - `WITH_ORPHANS=true` adds `OrphanA` and `OrphanC`, each declaring a TTL.
 *   verify.sh deploys that template as a role that may create a table but may
 *   neither set its TTL nor delete it, so each CREATE makes the table, waits
 *   for it ACTIVE, fails on `UpdateTimeToLive`, and cannot clean up: the
 *   journal records each as a proven orphan with the `TableId` its
 *   `CreateTable` answered with.
 * - `ORPHAN_FIX_FORWARD=true` keeps both orphan logical ids under other names
 *   (`-b`), so the fix-forward deploy creates two new global tables. Before
 *   it, verify.sh deletes `OrphanC`'s table and re-creates the name itself
 *   (one made outside the stack, under another `TableId`): the fix-forward
 *   must delete `OrphanA`'s table and keep that one.
 *
 * L1 global tables with explicit names, one replica in the stack's own region
 * (no cross-region replica: nothing to wait for, nothing billed elsewhere),
 * and only properties the GlobalTable SDK provider handles, so every table
 * stays on the SDK route (`provisionedBy: sdk`), where `isSameResource` /
 * `resourceIdentity` live. On-demand billing: no provisioned capacity is paid
 * for while a table sits orphaned.
 */
export class GlobalTableFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // No `cdk.Tags.of(this)`: `CfnGlobalTable` is not taggable (its tags
    // live on each replica), so a stack-level tag would reach nothing.

    const globalTable = (logicalId: string, tableName: string, ttl: boolean): void => {
      new dynamodb.CfnGlobalTable(this, logicalId, {
        tableName,
        keySchema: [{ attributeName: 'id', keyType: 'HASH' }],
        attributeDefinitions: [{ attributeName: 'id', attributeType: 'S' }],
        billingMode: 'PAY_PER_REQUEST',
        replicas: [{ region: this.region }],
        ...(ttl && { timeToLiveSpecification: { attributeName: 'ttl', enabled: true } }),
      });
    };

    globalTable('BaseTable', 'cdkd-gtffo-base', false);

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      globalTable('OrphanA', `cdkd-gtffo-a${suffix}`, true);
      globalTable('OrphanC', `cdkd-gtffo-c${suffix}`, true);
    }
  }
}
