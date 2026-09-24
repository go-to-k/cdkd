import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for `cdkd import --migrate-from-cloudformation` recording the
 * attribute maps `create()` records (issue #3627), for the types whose
 * attributes the resolver cannot build from the physical id:
 *
 * - `AWS::SNS::Topic` `TopicName`: the physical id is the ARN, which the
 *   resolver read as a name (an ARN-valued name, no warning).
 * - `AWS::DynamoDB::Table` `StreamArn`: the resolver arm returns `undefined`.
 * - `AWS::IAM::Role` `RoleId` (`undefined`) and `Arn` under a non-`/` `Path`.
 * - `AWS::Lambda::EventSourceMapping` `EventSourceMappingArn`: refused.
 *
 * One SSM parameter per attribute carries the `Fn::GetAtt`, so the assertion
 * reads the imported parameter record. Logical ids are pinned so verify.sh can
 * name them.
 */
export class ImportAttributeReadbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const pin = (c: Construct, logicalId: string) =>
      (c.node.defaultChild as cdk.CfnResource).overrideLogicalId(logicalId);
    const param = (logicalId: string, value: string) => {
      const p = new ssm.StringParameter(this, logicalId, { stringValue: value });
      pin(p, logicalId);
    };

    const topic = new sns.Topic(this, 'Topic');
    pin(topic, 'Topic');
    param('TopicNameParam', topic.topicName);

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.KEYS_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    pin(table, 'Table');
    param('StreamArnParam', table.tableStreamArn!);

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      path: '/cdkd-integ/',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    pin(role, 'Role');
    param('RoleIdParam', role.roleId);
    param('RoleArnParam', role.roleArn);

    const fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context):\n    return None\n'),
      role,
    });
    table.grantStreamRead(fn);
    const esm = new lambda.CfnEventSourceMapping(this, 'Esm', {
      functionName: fn.functionName,
      eventSourceArn: table.tableStreamArn!,
      startingPosition: 'LATEST',
      enabled: false,
    });
    esm.overrideLogicalId('Esm');
    esm.node.addDependency(role);
    param('EsmArnParam', esm.attrEventSourceMappingArn);
  }
}
