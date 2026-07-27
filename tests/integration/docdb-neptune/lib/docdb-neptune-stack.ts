import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as neptune from 'aws-cdk-lib/aws-neptune';

/**
 * cdkd DocDB + Neptune SDK provider E2E test stack.
 *
 * Verifies that the SDK providers added in PR #207 (DocDBProvider /
 * NeptuneProvider) work end-to-end against real AWS for create + destroy.
 * Pre-PR these types fell through to CC API which provided basic CRUD
 * but never ran in a unit test against the real shape of the
 * `Modify*Cluster` / `Describe*` / `Delete*` responses.
 *
 * Resources:
 *  - 1 VPC + 2 private isolated subnets in 2 AZs (DocDB / Neptune both
 *    require ≥ 2 subnets in distinct AZs via a DBSubnetGroup; private-
 *    isolated keeps it cheap — no NAT, no IGW).
 *  - 1 DocDB DBSubnetGroup
 *  - 1 DocDB DBCluster (1 instance, db.t3.medium, MasterUsername=admin,
 *    MasterUserPassword=TempPass1234! — chosen for AWS's accept rules:
 *    8–100 chars, no `/`, `"`, or `@`).
 *  - 1 DocDB DBInstance (db.t3.medium)
 *  - 1 Neptune DBSubnetGroup
 *  - 1 Neptune DBCluster (Neptune uses IAM auth so no Master credentials)
 *  - 1 Neptune DBInstance (db.t3.medium)
 *
 * #1160 (reset-on-removal) phases: the BASELINE deploy sets non-default
 * values for the reset-covered ModifyDBCluster fields on both clusters
 * (`deletionProtection: true` + `backupRetentionPeriod: 7`, plus
 * `iamAuthEnabled: true` on Neptune); the `CDKD_TEST_REMOVAL=true`
 * redeploy DROPS them entirely so cdkd's ModifyDBCluster sees ABSENT
 * fields (removal), not a value change. ModifyDBCluster has merge
 * semantics (an absent input field means "no change"), so without the
 * #1160 fix AWS would keep the baseline values — and
 * DeletionProtection=true would then make the destroy fail. verify.sh
 * asserts the live values return to the CFn defaults (false / 1 /
 * false), and the destroy succeeding WITHOUT --remove-protection is
 * itself proof the DeletionProtection reset landed.
 *
 * Every L1 resource has `RemovalPolicy: DESTROY`, and the removal-phase
 * template carries NO DeletionProtection, so the post-removal
 * `cdkd destroy --force` succeeds without `--remove-protection`.
 * SkipFinalSnapshot on cluster delete is unconditional (set inside the
 * providers).
 *
 * AZ + subnet layout uses `maxAzs: 2` (deterministic — DocDB / Neptune
 * subnet groups need at least 2 AZs and CDK's lookup picks the lowest
 * 2 by default).
 */
export class DocdbNeptuneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // #1160 (reset-on-removal) phase switch: CDKD_TEST_REMOVAL=true DROPS
    // the reset-covered cluster fields set by the baseline deploy (see the
    // file header). `undefined` removes the property from the synthesized
    // template entirely — the removal shape, not a value change.
    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';

    // VPC: 2 AZs, private-isolated only (no NAT, no IGW). DocDB and
    // Neptune are reached only via cluster endpoints inside the VPC,
    // which is fine for a deploy-then-destroy test (we never connect).
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Single shared SG. allowAllOutbound default; ingress empty.
    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      description: 'docdb-neptune integ shared SG',
      allowAllOutbound: true,
    });

    const subnetIds = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    }).subnetIds;

    // ── DocDB ─────────────────────────────────────────────────────────
    // Use L1 Cfn* directly so we can pin DeletionProtection: false and
    // applyRemovalPolicy DESTROY explicitly without relying on CDK L2
    // defaults. The L2 docdb.DatabaseCluster is opinionated and creates
    // additional resources (a SecretsManager secret, parameter groups);
    // staying at L1 keeps the integ surface focused on the provider.
    const docdbSubnetGroup = new docdb.CfnDBSubnetGroup(
      this,
      'DocdbSubnetGroup',
      {
        dbSubnetGroupDescription: 'cdkd integ docdb subnet group',
        subnetIds,
      }
    );
    docdbSubnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // MasterUsername: DocDB reserves `admin`, `root`, etc. — picked
    // `cdkdadmin` to satisfy the engine's reserved-word check.
    // MasterUserPassword: 8-100 chars, no `/`, `"`, `@`.
    const docdbCluster = new docdb.CfnDBCluster(this, 'DocdbCluster', {
      masterUsername: 'cdkdadmin',
      masterUserPassword: 'TempPass1234!',
      dbSubnetGroupName: docdbSubnetGroup.ref,
      vpcSecurityGroupIds: [sg.securityGroupId],
      // #1160 removable fields: non-default in the baseline deploy, DROPPED
      // in the CDKD_TEST_REMOVAL redeploy. verify.sh asserts they reset to
      // the CFn defaults (false / 1).
      deletionProtection: isRemoval ? undefined : true,
      backupRetentionPeriod: isRemoval ? undefined : 7,
      storageEncrypted: true,
    });
    docdbCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    docdbCluster.addDependency(docdbSubnetGroup);

    const docdbInstance = new docdb.CfnDBInstance(this, 'DocdbInstance', {
      dbClusterIdentifier: docdbCluster.ref,
      dbInstanceClass: 'db.t3.medium',
    });
    docdbInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    docdbInstance.addDependency(docdbCluster);

    // ── Neptune ───────────────────────────────────────────────────────
    // Neptune uses IAM auth — no MasterUsername / MasterUserPassword.
    const neptuneSubnetGroup = new neptune.CfnDBSubnetGroup(
      this,
      'NeptuneSubnetGroup',
      {
        dbSubnetGroupDescription: 'cdkd integ neptune subnet group',
        subnetIds,
      }
    );
    neptuneSubnetGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const neptuneCluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbSubnetGroupName: neptuneSubnetGroup.ref,
      vpcSecurityGroupIds: [sg.securityGroupId],
      // #1160 removable fields: non-default in the baseline deploy, DROPPED
      // in the CDKD_TEST_REMOVAL redeploy. verify.sh asserts they reset to
      // the CFn defaults (false / 1 / false). `iamAuthEnabled` is the CFn
      // spelling of ModifyDBCluster's EnableIAMDatabaseAuthentication.
      deletionProtection: isRemoval ? undefined : true,
      backupRetentionPeriod: isRemoval ? undefined : 7,
      iamAuthEnabled: isRemoval ? undefined : true,
      storageEncrypted: true,
    });
    neptuneCluster.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    neptuneCluster.addDependency(neptuneSubnetGroup);

    const neptuneInstance = new neptune.CfnDBInstance(this, 'NeptuneInstance', {
      dbClusterIdentifier: neptuneCluster.ref,
      dbInstanceClass: 'db.t3.medium',
    });
    neptuneInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    neptuneInstance.addDependency(neptuneCluster);

    // Outputs for human-readable verification (verify.sh greps the
    // post-deploy state list, not these — but they are useful when
    // debugging a failed run from the CLI).
    new cdk.CfnOutput(this, 'DocdbClusterId', { value: docdbCluster.ref });
    new cdk.CfnOutput(this, 'DocdbInstanceId', { value: docdbInstance.ref });
    new cdk.CfnOutput(this, 'NeptuneClusterId', { value: neptuneCluster.ref });
    new cdk.CfnOutput(this, 'NeptuneInstanceId', { value: neptuneInstance.ref });
  }
}
