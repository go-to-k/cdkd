import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as neptunegraph from 'aws-cdk-lib/aws-neptunegraph';
import * as smsvoice from 'aws-cdk-lib/aws-smsvoice';
import * as verifiedpermissions from 'aws-cdk-lib/aws-verifiedpermissions';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as docdb from 'aws-cdk-lib/aws-docdb';

/**
 * Integ probe for the generic CC-routed deletion-protection flip behind
 * `cdkd destroy --remove-protection` (issues #1314 / #1315, mechanism from
 * #1312). All five types are Tier 2 (no SDK Provider) and deploy with
 * protection ON from creation, so a bare destroy must fail on every one of
 * them and a `--remove-protection` destroy must flip each protection
 * property off via a Cloud Control UpdateResource patch and delete cleanly.
 *
 * covers: AWS::NeptuneGraph::Graph
 * covers: AWS::SMSVOICE::ProtectConfiguration
 * covers: AWS::VerifiedPermissions::PolicyStore
 * covers: AWS::RDS::GlobalCluster
 * covers: AWS::DocDB::GlobalCluster
 *
 * The RDS / DocDB global clusters are headless SHELLS (Engine only, no
 * member cluster) — CreateGlobalCluster accepts either Engine or a source
 * cluster, so the shell form verifies the protection flip without paying
 * for a regional Aurora / DocDB cluster.
 *
 * The graph and both global clusters have deterministic names and the
 * other two carry a deterministic tag / description so verify.sh's cleanup
 * can discover leftovers without state.
 */
export class CcProtectionFlipStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new neptunegraph.CfnGraph(this, 'Graph', {
      graphName: 'cdkd-ccprot-graph',
      provisionedMemory: 16,
      deletionProtection: true,
      tags: [{ key: 'cdkd-integ', value: 'ccprot' }],
    });

    new smsvoice.CfnProtectConfiguration(this, 'ProtectConfig', {
      deletionProtectionEnabled: true,
      tags: [{ key: 'cdkd-integ', value: 'ccprot' }],
    });

    new verifiedpermissions.CfnPolicyStore(this, 'PolicyStore', {
      description: 'cdkd-integ-ccprot',
      validationSettings: { mode: 'OFF' },
      deletionProtection: { mode: 'ENABLED' },
    });

    new rds.CfnGlobalCluster(this, 'RdsGlobal', {
      globalClusterIdentifier: 'cdkd-ccprot-rds-global',
      engine: 'aurora-postgresql',
      deletionProtection: true,
    });

    new docdb.CfnGlobalCluster(this, 'DocdbGlobal', {
      globalClusterIdentifier: 'cdkd-ccprot-docdb-global',
      engine: 'docdb',
      deletionProtection: true,
    });
  }
}
