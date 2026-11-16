import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as sqs from 'aws-cdk-lib/aws-sqs';

// cdkd Cognito UserPool rollback over an added custom attribute (issue #6375).
//
// Base: a pool with custom attribute `team` and an 8-character password minimum.
// CDKD_TEST_UPDATE=true: also add custom attribute `level` and raise the
//   minimum to 12.
// CDKD_TEST_FAIL=true: also declare a queue AWS rejects (retention out of
//   range), ordered after the pool, so the pool update lands first and the
//   rollback then reverts it.
//
// AWS can only ADD custom attributes, so the rollback cannot take `level` back
// off. Before the fix the revert applied the 8-character minimum and THEN
// refused the schema, so state kept the 12-character record over a pool
// holding 8, and the next deploy of the update diffed NO_CHANGE.
export class CognitoSchemaRollbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    const customAttributes: Record<string, cognito.ICustomAttribute> = {
      team: new cognito.StringAttribute({ mutable: true }),
    };
    if (update) {
      customAttributes['level'] = new cognito.NumberAttribute({ min: 1, max: 9, mutable: true });
    }

    const pool = new cognito.UserPool(this, 'Pool', {
      userPoolName: 'cdkd-cognito-schema-rollback-test',
      signInAliases: { email: true },
      customAttributes,
      passwordPolicy: { minLength: update ? 12 : 8 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (process.env.CDKD_TEST_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(pool);
    }
  }
}
