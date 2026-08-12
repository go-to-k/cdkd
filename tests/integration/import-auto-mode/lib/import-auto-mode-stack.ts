import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as glue from 'aws-cdk-lib/aws-glue';

/**
 * Integ probe for `cdkd import` AUTO mode (issue #1128).
 *
 * Auto mode resolves each resource's physical id in stages: the template's own
 * name property first, then an `aws:cdk:path` tag walk, and (since #1128) a
 * CloudFormation `DescribeStackResources` lookup. The tag stage CANNOT match on
 * real AWS — AWS rejects any `aws:`-prefixed tag write ("Tag keys beginning
 * with aws: are reserved for system use") and CloudFormation keeps the value in
 * the template's resource `Metadata` without ever promoting it to a tag.
 *
 * That made auto mode fail for any resource whose physical name CloudFormation
 * generated, which is the usual CDK shape. It survived four rounds of
 * `importTagWalk` work (#1091) because BOTH existing import integs bypass the
 * path: `import-attributes` passes `--resource`, `import-nested-stack` passes
 * `--migrate-from-cloudformation`.
 *
 * The load-bearing property of this fixture is therefore what it does NOT do:
 *
 *   - it does NOT set an explicit physical name (no `managedPolicyName`), so
 *     the name stage cannot resolve it and the resource can ONLY be found via
 *     the CloudFormation lookup;
 *   - `verify.sh` does NOT pass `--resource` or
 *     `--migrate-from-cloudformation`, so nothing short-circuits the path
 *     under test.
 *
 * Adding a physical name here, or an override flag there, would silently
 * restore the green-but-untested state this fixture exists to end.
 *
 * `AWS::IAM::ManagedPolicy` is the resource because it is free, fast, has no
 * VPC/NAT dependency, and deletes cleanly with no recovery window.
 *
 * ---
 *
 * The Glue pair covers the SECOND failure of the same path (issue #1651).
 *
 * #1128 fixed the RESOLUTION of a CloudFormation-generated id; #1651 is a
 * provider REJECTING the id auto mode had already resolved. cdkd's physicalId
 * for `AWS::Glue::Table` is the composite `<databaseName>|<tableName>`, while
 * CloudFormation's is the table name alone — so `importTable` split on `|`,
 * found no second segment, and returned `not found` without ever calling AWS.
 * Every `cdk deploy`-managed Glue table was unadoptable, and the error told
 * the user to pass the very id that had just been rejected.
 *
 * The load-bearing properties here, mirroring the policy's:
 *
 *   - `DatabaseName` is a `Ref` to the sibling database, NOT a literal. That
 *     is what CDK renders, and it is the reason the fix can pair a bare table
 *     name with a database: `AWS::Glue::Database`'s CFn physicalId IS the
 *     database name, so the overrides map resolves the `Ref` to a literal
 *     before `provider.import()` runs. Inlining the string here would make
 *     the fixture pass through a path CDK users never take.
 *   - `verify.sh` asserts the ADOPTED physicalId is the composite form, not
 *     merely that the import exited 0. Recording CloudFormation's bare name
 *     would look like success and leave a state record every other method on
 *     the provider (update / delete / getAttribute / readCurrentState) cannot
 *     split — trading a visible not-found for a silent one.
 *
 * Glue names are restricted to lowercase alphanumerics and underscore, so
 * unlike the policy these carry explicit names; CloudFormation cannot generate
 * a conforming one. That costs nothing here — the id SHAPE, not its origin, is
 * what #1651 is about.
 */
export class ImportAutoModeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // NOTE: no `managedPolicyName`. CloudFormation generates
    // `<Stack>-Policy-<suffix>`, which is exactly the shape that used to come
    // back as `not found`.
    const policy = new iam.ManagedPolicy(this, 'Policy', {
      description: 'cdkd import auto-mode integ probe (issue #1128)',
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:ListAllMyBuckets'],
          resources: ['*'],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'PolicyArn', {
      value: policy.managedPolicyArn,
      description: 'ARN of the probe policy (CloudFormation-generated name)',
    });

    // --- issue #1651: composite physicalId vs CloudFormation's -------------
    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: {
        name: 'cdkd_import_auto_mode_db',
        description: 'cdkd import auto-mode integ probe (issue #1651)',
      },
    });

    const table = new glue.CfnTable(this, 'Table', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      // NOTE: a `Ref`, not a literal. See the class doc — resolving this
      // through the overrides map is exactly what lets the fix pair
      // CloudFormation's bare table name with a database.
      databaseName: database.ref,
      tableInput: {
        name: 'cdkd_import_auto_mode_table',
        description: 'cdkd import auto-mode integ probe (issue #1651)',
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          columns: [{ name: 'id', type: 'string' }],
        },
      },
    });
    table.addDependency(database);

    new cdk.CfnOutput(this, 'TableName', {
      value: table.ref,
      description:
        "CloudFormation's physicalId for the table — the table NAME alone, " +
        "never cdkd's composite <db>|<table> (issue #1651)",
    });
  }
}
