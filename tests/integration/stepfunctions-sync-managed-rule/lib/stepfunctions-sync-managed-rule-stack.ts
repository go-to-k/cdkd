import * as cdk from 'aws-cdk-lib';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

/**
 * Issue #6081: a state machine whose definition uses a `.sync` (RUN_JOB)
 * integration. When that integration's EventBridge managed rule
 * (`StepFunctionsGetEventsForBatchJobsRule` here) does not exist yet in the
 * account and region, CreateStateMachine checks that the role may create it,
 * and cdkd issues the call ~0.2s after the role's DefaultPolicy CREATE, so AWS
 * answers "is not authorized to create managed-rule" until the grant
 * propagates. verify.sh deletes the rule before the deploy to reach that path.
 *
 * The window opens only when the state machine's role is OLDER than its
 * assume-role propagation window when the DefaultPolicy lands: against a
 * brand-new role, the "Neither the global service principal ..." rejection
 * fires first and the policy propagates behind it (both measured live). The
 * `LambdaInvoke` branch makes the DefaultPolicy read the function's ARN, so
 * the policy -- and the state machine right after it -- wait for the function
 * (and its own role) to be created, ageing the state machine's role first.
 * That is the shape the bug was found in.
 *
 * The Batch queue and job definition are imported by ARN and never created:
 * Step Functions validates only the definition's shape at create time, and
 * the fixture never starts an execution.
 */
export class StepfunctionsSyncManagedRuleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const jobQueue = batch.JobQueue.fromJobQueueArn(
      this,
      'Queue',
      `arn:${this.partition}:batch:${this.region}:${this.account}:job-queue/cdkd-integ-none`
    );
    const jobDefinition = batch.EcsJobDefinition.fromJobDefinitionArn(
      this,
      'JobDef',
      `arn:${this.partition}:batch:${this.region}:${this.account}:job-definition/cdkd-integ-none:1`
    );

    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
    });

    const parallel = new sfn.Parallel(this, 'Par');
    parallel.branch(new tasks.LambdaInvoke(this, 'Invoke', { lambdaFunction: fn }));
    parallel.branch(
      new tasks.BatchSubmitJob(this, 'Submit', {
        jobName: 'cdkd-integ',
        jobQueueArn: jobQueue.jobQueueArn,
        jobDefinitionArn: jobDefinition.jobDefinitionArn,
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      })
    );

    new sfn.StateMachine(this, 'SyncMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(parallel),
    });
  }
}
