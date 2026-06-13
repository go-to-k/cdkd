import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * IAM-propagation stress stack.
 *
 * GOAL: maximize the chance of catching an UNRETRIED IAM-propagation race.
 *
 * cdkd's fast SDK path creates an IAM role and then has a service assume it
 * within ~1s, before IAM finishes propagating the just-created role / its
 * trust policy. CloudFormation never hits this because its deployment latency
 * lets IAM settle; cdkd does not, so every "role created -> assumed within
 * ~1s" edge is a potential race. The race is already handled NARROWLY for a
 * few consumers (RDS Enhanced Monitoring #794, ECS CapacityProvider #805,
 * Custom Resource #756), but MANY other consumers are unprotected.
 *
 * This single stack creates SEVERAL freshly-made IAM roles, each consumed
 * IMMEDIATELY by a DIFFERENT service in the same deploy, so the DAG carries
 * many independent race edges at once:
 *
 *   Race edge 1: Lambda exec role  -> Lambda::Function (CreateFunction
 *                validates the role can be assumed by lambda.amazonaws.com).
 *   Race edge 2: SFN role          -> StepFunctions::StateMachine
 *                (CreateStateMachine validates the role trust + permissions;
 *                cdkd's SFN provider has NO propagation retry of its own).
 *   Race edge 3: EventBridge target role -> Events::Rule with an SFN target
 *                (PutTargets validates the rule can assume the target role to
 *                StartExecution on the state machine).
 *   Race edge 4: SQS QueuePolicy + SNS TopicPolicy referencing a fresh
 *                principal/role (resource-policy validates the principal).
 *
 * Everything is cheap and deployable: no VPC, no NAT, no long-lived compute.
 * The point is breadth of fresh-role edges, not resource count.
 *
 * The deploy SUCCEEDING is the pass condition — this is a race DETECTOR. A
 * flaky failure here is a real cdkd finding (an unprotected consumer racing
 * IAM propagation).
 */
export class IamPropagationStressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // A tag every fixture resource carries so the integ can find + assert
    // teardown by tag (cdkd does NOT apply aws:cdk:path, so we own this tag).
    cdk.Tags.of(this).add('cdkd:integ-fixture', 'iam-propagation-stress');

    // -----------------------------------------------------------------
    // Race edge 1: a brand-new Lambda exec role consumed by a Lambda the
    // same deploy invokes. We build the role EXPLICITLY (not the implicit
    // CDK-managed one) so the role and the function are two distinct DAG
    // nodes with a Ref edge — i.e. the function's CreateFunction fires as
    // soon as the role create completes, the tightest possible race window.
    // -----------------------------------------------------------------
    const lambdaRole = new iam.Role(this, 'WorkerLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    const workerFn = new lambda.Function(this, 'WorkerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      role: lambdaRole,
    });

    // -----------------------------------------------------------------
    // Race edge 2: a brand-new SFN role consumed by a StateMachine. The
    // state machine's only task invokes the Lambda above, so the SFN role
    // must be able to lambda:InvokeFunction — another fresh-grant edge.
    // -----------------------------------------------------------------
    const sfnRole = new iam.Role(this, 'StateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    workerFn.grantInvoke(sfnRole);

    // Pass:Wait:InvokeLambda definition. Using a literal Pass + a Lambda
    // invoke gives a real role-consuming state machine without extra cost.
    const passState = new sfn.Pass(this, 'StartPass', {
      result: sfn.Result.fromObject({ started: true }),
    });
    const invokeTask = new sfn.CustomState(this, 'InvokeWorker', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Parameters: {
          FunctionName: workerFn.functionArn,
          'Payload.$': '$',
        },
        End: true,
      },
    });

    const stateMachine = new sfn.StateMachine(this, 'StressStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(passState.next(invokeTask)),
      role: sfnRole,
      timeout: cdk.Duration.minutes(5),
    });

    // -----------------------------------------------------------------
    // Race edge 3: a brand-new EventBridge target role consumed by a
    // Rule whose target is the state machine above. EventBridge's
    // PutTargets validates the rule can assume this role to StartExecution.
    // CDK auto-creates the events role when an SfnStateMachine target is
    // used; we let it (still a fresh role assumed immediately by the rule).
    // The rule is DISABLED + a far-future schedule so it never actually
    // fires (no per-minute cost / no spurious executions) — but PutTargets
    // still validates the role at create time, which is the race we want.
    // -----------------------------------------------------------------
    const eventRule = new events.Rule(this, 'StressRule', {
      // A schedule rule (no event bus dependency); disabled so it never
      // triggers, but the target + role wiring is still created + validated.
      schedule: events.Schedule.rate(cdk.Duration.days(365)),
      enabled: false,
    });
    eventRule.addTarget(new targets.SfnStateMachine(stateMachine));

    // -----------------------------------------------------------------
    // Race edge 4: a fresh role referenced as a principal in an SQS
    // QueuePolicy and an SNS TopicPolicy. The resource-policy PUT validates
    // the principal ARN; a just-created role principal can race propagation.
    // -----------------------------------------------------------------
    const publisherRole = new iam.Role(this, 'PublisherRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    const queue = new sqs.Queue(this, 'StressQueue', {
      retentionPeriod: cdk.Duration.minutes(5),
    });
    // addToResourcePolicy emits an AWS::SQS::QueuePolicy whose statement names
    // the fresh publisherRole as principal (SetQueueAttributes validates it).
    // NOTE: we call addToResourcePolicy directly rather than grantSendMessages
    // — granting to a same-account Role principal only edits the ROLE's
    // identity policy (AWS::IAM::Policy), it does NOT emit a QueuePolicy. A
    // direct resource-policy statement forces the AWS::SQS::QueuePolicy that
    // names the fresh principal, which is the resource-policy race edge.
    queue.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        principals: [publisherRole],
        resources: [queue.queueArn],
      })
    );

    const topic = new sns.Topic(this, 'StressTopic', {});
    // addToResourcePolicy emits an AWS::SNS::TopicPolicy naming the fresh
    // publisherRole as principal (SetTopicAttributes validates it).
    topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [publisherRole],
        resources: [topic.topicArn],
      })
    );

    // Outputs so verify.sh can resolve physical ids without guessing.
    new cdk.CfnOutput(this, 'WorkerFnName', { value: workerFn.functionName });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, 'RuleName', { value: eventRule.ruleName });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'TopicArn', { value: topic.topicArn });
  }
}
