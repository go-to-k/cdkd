import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Glue update / delete hardening integ stack.
 *
 * Exercises the four Glue provider fixes:
 *  1. Glue Job stringly-typed numeric coercion — `MaxCapacity` / `Timeout` /
 *     `NumberOfWorkers` / `MaxRetries` / `ExecutionProperty.MaxConcurrentRuns`
 *     are set as NUMBERS in CDK (they synth as STRINGS in the template), so the
 *     provider must coerce them back to numbers before the Glue SDK call.
 *  2. Glue Crawler running-state delete handling (verified by unit test; here
 *     the crawler is idle so it just creates + deletes cleanly).
 *  3. Glue Trigger state-machine — an ON_DEMAND trigger that runs the Job.
 *     CDKD_TEST_UPDATE flips its description to exercise the update path.
 *  4. Glue Workflow Tags from a MAP shape (CfnWorkflow `tags` is a `{k:v}` map)
 *     must reach AWS, not be silently dropped.
 *  5. Glue Crawler `Targets.DynamoDBTargets[].ScanAll` / `.ScanRate` (issue
 *     #1391). The SDK `DynamoDBTarget` is a lowercase island — `Path` is
 *     PascalCase but the scan tuning is `scanAll` / `scanRate` — while CFn
 *     spells them `ScanAll` / `ScanRate`. The SDK v3 serializer drops unknown
 *     members, so the tuning silently never reached AWS while the target
 *     itself (matched by `Path`) survived. CDKD_TEST_UPDATE flips both values
 *     so the update path is covered too.
 *  6. Glue Table `StorageDescriptor.SkewedInfo` (issue #1505). The provider's
 *     `buildStorageDescriptor` was an explicit allow-list that dropped this
 *     member outright, and the #1479 live-merge made a DECLARED one worse than
 *     a plain drop (declaring it suppressed the carry-forward while the builder
 *     sent nothing). CDKD_TEST_UPDATE flips the skewed value so the update path
 *     is covered too.
 *  7. Glue Database `TargetDatabase` (a RESOURCE LINK) and
 *     `CreateTableDefaultPermissions` (issue #1807) — `buildDatabaseInput`
 *     named only Description / LocationUri / Parameters, so both blocks were
 *     dropped silently. CDKD_TEST_UPDATE flips the granted permission set so
 *     the update path is covered with a second distinct payload.
 *
 * All resources are idle (no schedule, ON_DEMAND trigger), so deploy + destroy
 * is fast and clean — no quota, no running jobs.
 */
export class GlueUpdateHardeningStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // CDKD_TEST_UPDATE flips the trigger description + job timeout so a second
    // deploy of this same fixture exercises the update() paths.
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const scriptBucket = new s3.Bucket(this, 'ScriptBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // IAM role assumed by Glue for the Job + Crawler.
    const glueRole = new iam.Role(this, 'GlueRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole'),
      ],
    });
    scriptBucket.grantRead(glueRole);

    // Glue Job — numeric props. NOTE: CDK's L1 validator rejects stringly-typed
    // numerics at synth time, so the string-shaped template that the provider's
    // coercion fix targets cannot be produced via CDK here; that path is
    // exercised by the unit tests (string in -> number out). This fixture
    // proves the happy path (real numbers reach AWS unchanged) + clean destroy.
    const job = new glue.CfnJob(this, 'EtlJob', {
      name: `${this.stackName}-etl-job`.toLowerCase(),
      role: glueRole.roleArn,
      command: {
        name: 'glueetl',
        scriptLocation: `s3://${scriptBucket.bucketName}/scripts/etl.py`,
        pythonVersion: '3',
      },
      glueVersion: '4.0',
      maxRetries: 1,
      timeout: isUpdate ? 90 : 60,
      numberOfWorkers: 2,
      workerType: 'G.1X',
      executionProperty: {
        maxConcurrentRuns: 2,
      },
    });

    // DynamoDB table referenced by the Crawler's `dynamoDbTargets` entry below.
    // Never crawled (the crawler is idle) — it only has to exist so the target
    // is a real table. `tableName` is a Ref, which gives the DAG the
    // Crawler -> Table edge for free.
    const crawlerTable = new dynamodb.Table(this, 'CrawlerTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // CreateCrawler VALIDATES a DynamoDB target eagerly — it calls
    // dynamodb:DescribeTable as the crawler role — so the grant is required at
    // create time even though this crawler never runs. Without it the create
    // fails with AccessDeniedException on DescribeTable.
    crawlerTable.grantReadData(glueRole);

    // Glue Crawler — idle (no schedule). Targets a path under the script bucket
    // plus the DynamoDB table above.
    //
    // The scan tuning (issue #1391) deliberately uses NON-DEFAULT values so the
    // readback cannot be satisfied by an AWS-side default: `ScanAll` defaults to
    // `true` when unset, and `ScanRate` is stored as null when unset (the 0.5 /
    // 0.25 fallbacks are runtime behavior, not a persisted value). Base deploy
    // sends `false` / 0.9; CDKD_TEST_UPDATE sends `true` / 1.2 so the update
    // path is exercised with a second distinct pair.
    const crawler = new glue.CfnCrawler(this, 'EventsCrawler', {
      name: `${this.stackName}-crawler`.toLowerCase(),
      role: glueRole.roleArn,
      databaseName: `${this.stackName}-crawler-db`.toLowerCase(),
      targets: {
        s3Targets: [{ path: `s3://${scriptBucket.bucketName}/data/` }],
        dynamoDbTargets: [
          {
            path: crawlerTable.tableName,
            scanAll: isUpdate,
            scanRate: isUpdate ? 1.2 : 0.9,
          },
        ],
      },
    });
    // `grantReadData` above mutates GlueRoleDefaultPolicy, and nothing gives
    // the crawler a DAG edge to that policy (cdkd only adds implicit
    // role -> policy edges for Custom Resources and Lambda VpcConfig). Since
    // CreateCrawler eagerly calls dynamodb:DescribeTable AS the role, the
    // create otherwise races the policy attach and AWS reports it as
    // "Service is unable to assume the role ... to access null".
    crawler.node.addDependency(glueRole);

    // Glue Workflow — `tags` is a MAP shape (the shape that exposed the
    // silent-drop bug). MaxConcurrentRuns set as a NUMBER (synths as a string).
    new glue.CfnWorkflow(this, 'EtlWorkflow', {
      name: `${this.stackName}-workflow`.toLowerCase(),
      maxConcurrentRuns: 1,
      tags: {
        env: 'integ',
        team: 'data-platform',
      },
    });

    // Glue Database + Table — `StorageDescriptor.SkewedInfo` (issue #1505).
    //
    // `buildStorageDescriptor` was an explicit allow-list of 11 members, so
    // `SkewedInfo` (and its sibling `SchemaReference`) never reached AWS. The
    // #1479 merge made a DECLARED one worse than a plain drop: its key sets
    // come from the RAW template, so declaring the member suppressed the live
    // carry-forward while the builder produced nothing — erasing it outright.
    //
    // `SkewedColumnValueLocationMaps` is deliberately populated: CFn types it
    // as a free-form object while the SDK member is Record<string,string>, so
    // it also covers the value coercion. CDKD_TEST_UPDATE flips the skewed
    // value so the update path is exercised with a second distinct payload.
    const tableDb = new glue.CfnDatabase(this, 'TableDatabase', {
      catalogId: this.account,
      databaseInput: { name: `${this.stackName}-table-db`.toLowerCase() },
    });

    const skewedValue = isUpdate ? 'CA' : 'US';
    const skewedTable = new glue.CfnTable(this, 'SkewedTable', {
      catalogId: this.account,
      databaseName: `${this.stackName}-table-db`.toLowerCase(),
      tableInput: {
        name: `${this.stackName}-skewed-table`.toLowerCase(),
        tableType: 'EXTERNAL_TABLE',
        storageDescriptor: {
          location: `s3://${scriptBucket.bucketName}/skewed/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          columns: [
            { name: 'id', type: 'bigint' },
            { name: 'country', type: 'string' },
          ],
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: { 'field.delim': ',' },
          },
          skewedInfo: {
            skewedColumnNames: ['country'],
            skewedColumnValues: [skewedValue],
            skewedColumnValueLocationMaps: {
              [skewedValue]: `s3://${scriptBucket.bucketName}/skewed/${skewedValue}/`,
            },
          },
        },
      },
    });
    skewedTable.addDependency(tableDb);

    // 7. Glue Database `TargetDatabase` / `CreateTableDefaultPermissions`
    //    (issue #1807). `buildDatabaseInput` named only Description /
    //    LocationUri / Parameters, so both blocks were dropped on the floor:
    //    same spelling on the CFn and SDK sides, so nothing errored and
    //    `cdkd drift` could not see it either — a database declared as a
    //    RESOURCE LINK came up as a plain empty database.
    //
    //    A resource link is the honest shape for this: `TargetDatabase` is the
    //    ONLY thing that distinguishes it, so if the block is dropped the
    //    readback shows a plain database rather than a subtly different one.
    //    NOTE the link carries NO description — AWS refuses that combination
    //    outright ("Description and resource link cannot exist together in a
    //    database!", probed us-east-1 2026-08-13), which is also why the
    //    permissions arm lives on a SEPARATE database.
    const linkDb = new glue.CfnDatabase(this, 'ResourceLinkDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: `${this.stackName}-link-db`.toLowerCase(),
        targetDatabase: {
          catalogId: this.account,
          databaseName: `${this.stackName}-table-db`.toLowerCase(),
        },
      },
    });
    linkDb.addDependency(tableDb);

    // `CreateTableDefaultPermissions` on its own database. CDKD_TEST_UPDATE
    // flips the granted permission set so the UPDATE path is covered with a
    // second distinct payload — a stale carry-forward cannot pass. The
    // principal stays `IAM_ALLOWED_PRINCIPALS`, the value AWS itself defaults
    // to, so the fixture needs no Lake Formation onboarding; the PERMISSIONS
    // list is what makes the declared value differ from that default (probed:
    // an undeclared database reads back `[ALL]`, so `[SELECT]` / `[ALL,
    // DROP]` are both distinguishable from "cdkd sent nothing").
    new glue.CfnDatabase(this, 'DefaultPermissionsDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: `${this.stackName}-perm-db`.toLowerCase(),
        description: 'default table permissions probe',
        createTableDefaultPermissions: [
          {
            principal: { dataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
            permissions: isUpdate ? ['ALL', 'DROP'] : ['SELECT'],
          },
        ],
      },
    });

    // Glue Trigger — ON_DEMAND (idle, will not auto-fire) running the Job.
    const trigger = new glue.CfnTrigger(this, 'EtlTrigger', {
      name: `${this.stackName}-trigger`.toLowerCase(),
      type: 'ON_DEMAND',
      description: isUpdate ? 'updated trigger description' : 'initial trigger description',
      actions: [{ jobName: job.name! }],
    });
    trigger.addDependency(job);

    new cdk.CfnOutput(this, 'JobName', { value: job.name! });
    new cdk.CfnOutput(this, 'WorkflowName', { value: `${this.stackName}-workflow`.toLowerCase() });
    new cdk.CfnOutput(this, 'CrawlerName', { value: `${this.stackName}-crawler`.toLowerCase() });
    new cdk.CfnOutput(this, 'CrawlerTableName', { value: crawlerTable.tableName });
    new cdk.CfnOutput(this, 'TriggerName', { value: `${this.stackName}-trigger`.toLowerCase() });
    new cdk.CfnOutput(this, 'SkewedTableDbName', {
      value: `${this.stackName}-table-db`.toLowerCase(),
    });
    new cdk.CfnOutput(this, 'SkewedTableName', {
      value: `${this.stackName}-skewed-table`.toLowerCase(),
    });
  }
}
