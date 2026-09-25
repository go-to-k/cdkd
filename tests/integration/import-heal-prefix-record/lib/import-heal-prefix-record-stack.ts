import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for the #3627 heal-residual row: a record imported by a cdkd
 * OLDER than the `import()` read-backs lacks these attributes, and the
 * resolver arms answered without reaching the #1852 heal — `undefined` for
 * DynamoDB `StreamArn` / IAM `RoleId`, a path-less ARN for IAM. The fixture
 * imports with cdkd 0.291.13, then deploys with this checkout, which must
 * heal every row.
 */
export class ImportHealPrefixRecordStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pin = (c: cdk.CfnResource, logicalId: string) => c.overrideLogicalId(logicalId);
    const param = (logicalId: string, value: string) => {
      const p = new ssm.StringParameter(this, logicalId, { stringValue: value });
      pin(p.node.defaultChild as cdk.CfnResource, logicalId);
    };

    const table = new dynamodb.CfnTable(this, 'Table', {
      keySchema: [{ attributeName: 'pk', keyType: 'HASH' }],
      attributeDefinitions: [{ attributeName: 'pk', attributeType: 'S' }],
      billingMode: 'PAY_PER_REQUEST',
      streamSpecification: { streamViewType: 'KEYS_ONLY' },
    });
    table.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    pin(table, 'Table');
    param('StreamArnParam', table.attrStreamArn);

    const role = new iam.CfnRole(this, 'Role', {
      path: '/cdkd-integ/',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
    });
    pin(role, 'Role');
    param('RoleIdParam', role.attrRoleId);
    param('RoleArnParam', role.attrArn);

    const user = new iam.CfnUser(this, 'User', { path: '/cdkd-integ/' });
    pin(user, 'User');
    param('UserArnParam', user.attrArn);
  }
}
