import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';

/**
 * Minimal AWS::Budgets::Budget fixture for the new BudgetsBudgetProvider
 * (issue #1041). Budgets are free, so the fixture costs nothing.
 *
 * covers: AWS::Budgets::Budget
 *
 * Baseline: a 1 USD monthly cost budget with one ACTUAL/GREATER_THAN 80%
 * email notification.
 *
 * CDKD_TEST_UPDATE=true exercises the in-place UPDATE paths:
 *   - BudgetLimit 1 -> 2 USD (UpdateBudget; the budget name is unchanged so
 *     this must NOT replace the budget)
 *   - notification threshold 80 -> 90 (the reconciler deletes the old
 *     notification and creates the new one — notifications are addressed by
 *     value, there is no notification id)
 *   - a second email subscriber appears on the notification set
 */
export class BudgetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const budgetName = 'cdkd-budgets-integ-budget';
    const threshold = isUpdate ? 90 : 80;
    const subscribers = isUpdate
      ? [
          { subscriptionType: 'EMAIL', address: 'cdkd-integ@example.com' },
          { subscriptionType: 'EMAIL', address: 'cdkd-integ-2@example.com' },
        ]
      : [{ subscriptionType: 'EMAIL', address: 'cdkd-integ@example.com' }];

    const budget = new budgets.CfnBudget(this, 'CostBudget', {
      budget: {
        budgetName,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: isUpdate ? 2 : 1,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold,
          },
          subscribers,
        },
      ],
    });

    new cdk.CfnOutput(this, 'BudgetName', {
      value: budget.ref,
      description: 'Budget name (physical id)',
    });
  }
}
