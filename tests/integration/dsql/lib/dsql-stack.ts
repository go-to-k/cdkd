import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as dsql from 'aws-cdk-lib/aws-dsql';

/**
 * Integ probe for Aurora DSQL clusters on cdkd's Cloud Control API fallback
 * path (no SDK Provider is registered for AWS::DSQL::Cluster — Tier 2 in the
 * provider coverage report).
 *
 * covers: AWS::DSQL::Cluster
 *
 * DSQL clusters have NO user-settable name — the service generates the
 * identifier — so verify.sh discovers the cluster via the stack outputs
 * (ClusterId / ClusterArn) recorded in cdkd state, and the cleanup path
 * discovers leftovers by the deterministic `cdkd-integ=dsql` tag.
 *
 * Phase 1 (no env): a single-region cluster with deletion protection OFF
 * (the API default is ON, which would block destroy) and a phase-1 tag.
 * Phase 2 (CDKD_TEST_UPDATE=true): the same cluster with the `phase` tag
 * value flipped to `two` AND deletion protection flipped ON — an in-place
 * UPDATE through the CC API patch-document path covering both a tag change
 * and a top-level boolean flip. verify.sh asserts the cluster identity
 * (identifier + creationTime) is unchanged, proving no replacement
 * happened, then asserts a destroy attempt FAILS while protection is on,
 * re-deploys with protection off, and destroys cleanly.
 */
export class DsqlStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const phase = update ? 'two' : 'one';

    const cluster = new dsql.CfnCluster(this, 'Cluster', {
      deletionProtectionEnabled: update,
      tags: [
        { key: 'cdkd-integ', value: 'dsql' },
        { key: 'phase', value: phase },
      ],
    });

    new cdk.CfnOutput(this, 'ClusterId', { value: cluster.ref });
    new cdk.CfnOutput(this, 'ClusterArn', { value: cluster.attrResourceArn });
  }
}
