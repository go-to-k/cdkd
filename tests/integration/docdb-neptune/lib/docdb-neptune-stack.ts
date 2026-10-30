import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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
 * #1160 / #5004 (removal) phases: the BASELINE deploy sets non-default
 * values for the removable ModifyDBCluster fields on both clusters
 * (`deletionProtection: true` + `backupRetentionPeriod: 7`, plus
 * `iamAuthEnabled: true` on Neptune) and `autoMinorVersionUpgrade: false`
 * on the Neptune instance; the `CDKD_TEST_REMOVAL=true` redeploy DROPS them
 * entirely (while moving PreferredMaintenanceWindow tue -> wed on each
 * modified resource as a companion change proving the Modify* call fired) so cdkd's Modify* calls see ABSENT fields (removal), not a value
 * change. A real CloudFormation A/B (#5004) showed CloudFormation KEEPS the
 * live value of every one of these on removal, so verify.sh asserts the
 * baseline values are still live after the removal redeploy (cdkd must not
 * reset them to false / 1 / false / true). Each cluster also starts on a
 * non-default port (DocDB 27018, Neptune 8183) that the removal drops: a real
 * CloudFormation A/B (#1160) resets the DocDB one to 27017 and keeps the
 * Neptune one, and verify.sh asserts both. The Neptune cluster also drops
 * its `engineVersion` (1.4.7.0), `preferredBackupWindow` and cluster
 * parameter group, and the Neptune instance its parameter group: a real
 * CloudFormation A/B (#5544) keeps every one, so verify.sh asserts them
 * still live and asserts cdkd's warning naming each kept removal.
 *
 * Both clusters have `RemovalPolicy: SNAPSHOT` and every other L1 resource
 * `RemovalPolicy: DESTROY`. verify.sh turns DeletionProtection back ON out
 * of band for its issue #2204 arm (a `--remove-protection` destroy that fails
 * terminally must restore it), so the final destroy passes
 * `--remove-protection`. That destroy turns the guard off and then deletes
 * each cluster with a final snapshot, which needs the cluster `available`
 * again (issue #5184); verify.sh asserts both snapshots and deletes them.
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
    // Use L1 Cfn* directly so each removal policy is explicit rather than a
    // CDK L2 default. The L2 docdb.DatabaseCluster is opinionated and creates
    // additional resources (a SecretsManager secret, parameter groups);
    // staying at L1 keeps the integ surface focused on the provider.
    const docdbSubnetGroup = new docdb.CfnDBSubnetGroup(
      this,
      'DocdbSubnetGroup',
      {
        // Issue #2613: a changed description is an in-place
        // ModifyDBSubnetGroup, so the removal redeploy (step 3c) also reaches
        // the subnet group provider's update() and its recorded-region guard.
        dbSubnetGroupDescription: isRemoval
          ? 'cdkd integ docdb subnet group (updated)'
          : 'cdkd integ docdb subnet group',
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
      // Issue #1160: DROPPED in the CDKD_TEST_REMOVAL redeploy. CloudFormation
      // KEEPS a DocDB cluster's groups on removal (real A/B), so verify.sh
      // asserts the cluster is still on `Sg`.
      vpcSecurityGroupIds: isRemoval ? undefined : [sg.securityGroupId],
      // #1160 / #5004 removable fields: non-default in the baseline deploy,
      // DROPPED in the CDKD_TEST_REMOVAL redeploy. verify.sh asserts the
      // baseline values are RETAINED (CloudFormation keeps them).
      deletionProtection: isRemoval ? undefined : true,
      backupRetentionPeriod: isRemoval ? undefined : 7,
      // Companion change (#5004): an immediately-applied, read-back-at-once
      // property of the SAME ModifyDBCluster call, changed in the removal
      // deploy, so verify.sh can prove the Modify call FIRED before it
      // trusts the KEEP assertions (otherwise they pass vacuously).
      preferredMaintenanceWindow: isRemoval ? 'wed:05:00-wed:05:30' : 'tue:05:00-tue:05:30',
      // Issue #1160: a non-default port, DROPPED in the CDKD_TEST_REMOVAL
      // redeploy. CloudFormation resets a removed DocDB cluster Port to 27017
      // (real A/B), so verify.sh asserts 27017 after the removal.
      port: isRemoval ? undefined : 27018,
      storageEncrypted: true,
    });
    // Issue #5184: the final destroy takes a final snapshot after the
    // --remove-protection flip (see the file header).
    docdbCluster.applyRemovalPolicy(cdk.RemovalPolicy.SNAPSHOT);
    docdbCluster.addDependency(docdbSubnetGroup);
    // Issue #1160: once the removal drops the Ref, this keeps `Sg` deleted
    // AFTER the cluster that may still hold it (DependencyViolation otherwise).
    docdbCluster.node.addDependency(sg);
    // Issue #3866 refusal phase (verify.sh step 1b): `CopyTagsToSnapshot` is a
    // property the SDK provider does not handle, on a type Cloud Control has
    // no handlers for, so cdkd must refuse the deploy pre-flight rather than
    // route the cluster to Cloud Control. Never set on a deploy that succeeds.
    if (process.env.CDKD_TEST_NONPROV_REFUSAL === 'true') {
      docdbCluster.addPropertyOverride('CopyTagsToSnapshot', true);
    }

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

    // Issue #5544: custom parameter groups, attached in the baseline and
    // DETACHED from the template by the CDKD_TEST_REMOVAL redeploy. A real
    // CloudFormation A/B keeps both attached (neither moves back to
    // `default.neptune1.4`). Present in both deploys, so the removal deletes
    // neither while it is still attached.
    const neptuneClusterParams = new neptune.CfnDBClusterParameterGroup(
      this,
      'NeptuneClusterParams',
      {
        family: 'neptune1.4',
        description: 'cdkd integ neptune cluster parameter group (#5544)',
        parameters: { neptune_enable_audit_log: 1 },
      }
    );
    neptuneClusterParams.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    const neptuneInstanceParams = new neptune.CfnDBParameterGroup(
      this,
      'NeptuneInstanceParams',
      {
        family: 'neptune1.4',
        description: 'cdkd integ neptune instance parameter group (#5544)',
        parameters: { neptune_query_timeout: 120001 },
      }
    );
    neptuneInstanceParams.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const neptuneCluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbSubnetGroupName: neptuneSubnetGroup.ref,
      // Issue #1160: DROPPED in the CDKD_TEST_REMOVAL redeploy. CloudFormation
      // moves a Neptune cluster to the VPC's `default` security group on
      // removal (real A/B), so verify.sh asserts exactly that.
      vpcSecurityGroupIds: isRemoval ? undefined : [sg.securityGroupId],
      // #1160 / #5004 removable fields: non-default in the baseline deploy,
      // DROPPED in the CDKD_TEST_REMOVAL redeploy. verify.sh asserts the
      // baseline values are RETAINED (CloudFormation keeps them).
      // `iamAuthEnabled` is the CFn
      // spelling of ModifyDBCluster's EnableIAMDatabaseAuthentication.
      deletionProtection: isRemoval ? undefined : true,
      backupRetentionPeriod: isRemoval ? undefined : 7,
      iamAuthEnabled: isRemoval ? undefined : true,
      // Companion change (#5004): proves ModifyDBCluster fired (see DocDB).
      preferredMaintenanceWindow: isRemoval ? 'wed:05:00-wed:05:30' : 'tue:05:00-tue:05:30',
      // Issue #1160: a non-default port, DROPPED in the CDKD_TEST_REMOVAL
      // redeploy. CloudFormation KEEPS a removed Neptune DBPort (real A/B), so
      // verify.sh asserts 8183 is still live after the removal.
      dbPort: isRemoval ? undefined : 8183,
      // Issue #5544: an engine below the default (1.4.8.0 on 2026-10-30), a
      // backup window and the custom parameter group, DROPPED in the
      // CDKD_TEST_REMOVAL redeploy. CloudFormation KEEPS all three (real
      // A/B), so verify.sh asserts they are still live and that cdkd's
      // warning names them.
      engineVersion: isRemoval ? undefined : '1.4.7.0',
      preferredBackupWindow: isRemoval ? undefined : '03:00-03:30',
      dbClusterParameterGroupName: isRemoval ? undefined : neptuneClusterParams.ref,
      storageEncrypted: true,
    });
    // Issue #5184: the final destroy takes a final snapshot after the
    // --remove-protection flip (see the file header).
    neptuneCluster.applyRemovalPolicy(cdk.RemovalPolicy.SNAPSHOT);
    neptuneCluster.addDependency(neptuneSubnetGroup);
    // Issue #1160: see the DocDB cluster's dependency on `Sg`.
    neptuneCluster.node.addDependency(sg);
    // Issue #5544: as `Sg`, so the destroy after the removal still deletes
    // the cluster before its (still attached) parameter group.
    neptuneCluster.addDependency(neptuneClusterParams);

    const neptuneInstance = new neptune.CfnDBInstance(this, 'NeptuneInstance', {
      dbClusterIdentifier: neptuneCluster.ref,
      dbInstanceClass: 'db.t3.medium',
      // #5004: non-default (the API default is true); dropped on removal and
      // expected to stay false.
      autoMinorVersionUpgrade: isRemoval ? undefined : false,
      // Companion change (#5004): proves ModifyDBInstance fired.
      preferredMaintenanceWindow: isRemoval ? 'wed:06:00-wed:06:30' : 'tue:06:00-tue:06:30',
      // Issue #5544: DROPPED in the CDKD_TEST_REMOVAL redeploy; CloudFormation
      // keeps it attached (real A/B), so verify.sh asserts it still is.
      dbParameterGroupName: isRemoval ? undefined : neptuneInstanceParams.ref,
    });
    neptuneInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    neptuneInstance.addDependency(neptuneCluster);
    neptuneInstance.addDependency(neptuneInstanceParams);

    // Outputs for human-readable verification (verify.sh greps the
    // post-deploy state list, not these — but they are useful when
    // debugging a failed run from the CLI).
    new cdk.CfnOutput(this, 'DocdbClusterId', { value: docdbCluster.ref });
    new cdk.CfnOutput(this, 'DocdbInstanceId', { value: docdbInstance.ref });
    new cdk.CfnOutput(this, 'NeptuneClusterId', { value: neptuneCluster.ref });
    new cdk.CfnOutput(this, 'NeptuneInstanceId', { value: neptuneInstance.ref });

    // ── Issue #3650: endpoint Fn::GetAtt names ────────────────────────
    // DocDB / Neptune name these attributes `Endpoint` / `Port` /
    // `ReadEndpoint` (not RDS's dotted `Endpoint.Address`). cdkd recorded only
    // the dotted keys, so each of these resolved to the cluster / instance
    // IDENTIFIER. One SSM parameter per attribute carries the GetAtt;
    // verify.sh compares each against DescribeDBClusters / DescribeDBInstances.
    // Present in both deploys, so the CDKD_TEST_REMOVAL redeploy does not
    // delete them.
    const endpointParams: Record<string, string> = {
      DocdbClusterEndpointParam: docdbCluster.attrEndpoint,
      DocdbClusterPortParam: docdbCluster.attrPort,
      DocdbClusterReadEndpointParam: docdbCluster.attrReadEndpoint,
      DocdbInstanceEndpointParam: docdbInstance.attrEndpoint,
      NeptuneClusterEndpointParam: neptuneCluster.attrEndpoint,
      NeptuneClusterPortParam: neptuneCluster.attrPort,
      NeptuneClusterReadEndpointParam: neptuneCluster.attrReadEndpoint,
      NeptuneInstanceEndpointParam: neptuneInstance.attrEndpoint,
    };
    for (const [logicalId, value] of Object.entries(endpointParams)) {
      const param = new ssm.StringParameter(this, logicalId, { stringValue: value });
      (param.node.defaultChild as cdk.CfnResource).overrideLogicalId(logicalId);
    }
  }
}
