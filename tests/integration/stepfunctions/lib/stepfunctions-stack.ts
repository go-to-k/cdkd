import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

/**
 * Step Functions example stack
 *
 * Demonstrates:
 * - Lambda function with inline code
 * - Step Functions state machine with multiple state types
 * - LambdaInvoke task
 * - Wait state (1 second)
 * - Choice state with branching logic
 * - Succeed and Fail terminal states
 * - Auto-created IAM roles for state machine and Lambda
 * - CfnOutputs for StateMachine ARN and Lambda function name
 */
export class StepFunctionsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Lambda function with inline code
    const fn = new lambda.Function(this, 'ProcessorFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import random

def handler(event, context):
    """Simple processor that randomly succeeds or fails."""
    input_value = event.get('value', 0)
    result = input_value * 2
    success = result < 100

    return {
        'statusCode': 200,
        'input': input_value,
        'result': result,
        'success': success,
    }
`),
      timeout: cdk.Duration.seconds(10),
    });

    // Define Step Functions states

    // 1. LambdaInvoke task
    const invokeTask = new tasks.LambdaInvoke(this, 'InvokeProcessor', {
      lambdaFunction: fn,
      outputPath: '$.Payload',
    });

    // 2. Wait state (1 second)
    const waitState = new sfn.Wait(this, 'WaitOneSecond', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(1)),
    });

    // 3. Succeed state
    const succeedState = new sfn.Succeed(this, 'ProcessingSucceeded', {
      comment: 'Processing completed successfully',
    });

    // 4. Fail state
    const failState = new sfn.Fail(this, 'ProcessingFailed', {
      cause: 'Result exceeded threshold',
      error: 'ThresholdExceeded',
    });

    // 5. Choice state - branch based on Lambda result
    const choiceState = new sfn.Choice(this, 'CheckResult')
      .when(sfn.Condition.booleanEquals('$.success', true), succeedState)
      .otherwise(failState);

    // Build the state machine definition
    const definition = invokeTask.next(waitState).next(choiceState);

    // Create the state machine
    const stateMachine = new sfn.StateMachine(this, 'ProcessorStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(5),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Outputs
    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'Step Functions state machine ARN',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function name',
    });
  }
}
