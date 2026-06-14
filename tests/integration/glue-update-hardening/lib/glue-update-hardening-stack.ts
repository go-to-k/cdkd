import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as glue from 'aws-cdk-lib/aws-glue';

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

    // Glue Crawler — idle (no schedule). Targets a path under the script bucket.
    new glue.CfnCrawler(this, 'EventsCrawler', {
      name: `${this.stackName}-crawler`.toLowerCase(),
      role: glueRole.roleArn,
      databaseName: `${this.stackName}-crawler-db`.toLowerCase(),
      targets: {
        s3Targets: [{ path: `s3://${scriptBucket.bucketName}/data/` }],
      },
    });

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
    new cdk.CfnOutput(this, 'TriggerName', { value: `${this.stackName}-trigger`.toLowerCase() });
  }
}
