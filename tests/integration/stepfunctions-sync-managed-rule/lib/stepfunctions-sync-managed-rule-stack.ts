import * as cdk from 'aws-cdk-lib';
import * as batch from 'aws-cdk-lib/aws-batch';
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

    new sfn.StateMachine(this, 'SyncMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(
        new tasks.BatchSubmitJob(this, 'Submit', {
          jobName: 'cdkd-integ',
          jobQueueArn: jobQueue.jobQueueArn,
          jobDefinitionArn: jobDefinition.jobDefinitionArn,
          integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        })
      ),
    });
  }
}
