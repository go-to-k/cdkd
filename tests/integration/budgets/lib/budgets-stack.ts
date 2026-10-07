import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as sqs from 'aws-cdk-lib/aws-sqs';

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
 *   - ResourceTags env=dev, team=platform -> env=prod with team REMOVED
 *     (the tag diff: UntagResource for the dropped key, TagResource for the
 *     changed one; issue #3989)
 *
 * The SQS queue is the `cdkd drift` sibling (issue #2151): the budget's SDK
 * provider has no `readCurrentState` and the type has no Cloud Control READ
 * handler, so drift must report it unknown while still comparing the queue.
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
      resourceTags: isUpdate
        ? [{ key: 'env', value: 'prod' }]
        : [
            { key: 'env', value: 'dev' },
            { key: 'team', value: 'platform' },
          ],
    });

    new sqs.Queue(this, 'DriftSibling', {
      queueName: 'cdkd-budgets-drift-sibling',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'BudgetName', {
      value: budget.ref,
      description: 'Budget name (physical id)',
    });
  }
}
