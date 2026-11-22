import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * A Budgets action created seconds after its same-stack execution role
 * (issue #6845). Budgets validates at create time that it can assume
 * `ExecutionRoleArn`, and refuses a role IAM has not propagated yet with
 * "Budgets permission required to assume [ExecutionRole: ...]". Before the fix
 * cdkd failed the create on that first answer and the rollback deleted the
 * role, so every re-run met the race again.
 *
 * covers: AWS::Budgets::BudgetsAction
 *
 * Budgets and IAM are free. The action never runs: `ApprovalModel: MANUAL`
 * waits for an approval nobody gives, the budget is filtered to SQS spend with
 * a 1000 USD limit, and the policy it would attach denies one SQS action on
 * a role nothing assumes.
 */
export class BudgetsActionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const budget = new budgets.CfnBudget(this, 'ActionBudget', {
      budget: {
        budgetName: 'cdkd-budgets-action-integ-budget',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 1000, unit: 'USD' },
        filterExpression: {
          dimensions: { key: 'SERVICE', values: ['Amazon Simple Queue Service'] },
        },
      },
    });

    // The role the action would attach the policy to. Nothing assumes it.
    const targetRole = new iam.Role(this, 'TargetRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    const guardPolicy = new iam.ManagedPolicy(this, 'GuardPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['sqs:SendMessage'],
          resources: ['*'],
        }),
      ],
    });

    // The subject: a fresh role Budgets must assume at the action's create.
    const executionRole = new iam.Role(this, 'BudgetActionRole', {
      assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com'),
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: [targetRole.roleArn],
      }),
    );

    const action = new budgets.CfnBudgetsAction(this, 'BudgetStopAction', {
      budgetName: budget.ref,
      notificationType: 'ACTUAL',
      actionType: 'APPLY_IAM_POLICY',
      actionThreshold: { type: 'PERCENTAGE', value: 100 },
      approvalModel: 'MANUAL',
      definition: {
        iamActionDefinition: {
          policyArn: guardPolicy.managedPolicyArn,
          roles: [targetRole.roleName],
        },
      },
      executionRoleArn: executionRole.roleArn,
      subscribers: [{ type: 'EMAIL', address: 'cdkd-integ@example.com' }],
    });
    // The issue's shape: the action waits for the role (and its policy), so
    // what remains is IAM propagation, not ordering.
    action.node.addDependency(executionRole);

    new cdk.CfnOutput(this, 'BudgetName', { value: budget.ref });
    new cdk.CfnOutput(this, 'ExecutionRoleArn', { value: executionRole.roleArn });
  }
}
