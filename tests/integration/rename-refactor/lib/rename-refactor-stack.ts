import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * The daily "refactor rename" structural pattern: the construct ids (and thus
 * logical ids) of a queue, a table, and a lambda change between the baseline
 * deploy and the CDKD_TEST_UPDATE deploy, while an events Rule with a STABLE
 * construct id keeps targeting the (renamed) lambda. One deploy must therefore
 * create the new resources, retarget the kept rule, and delete the old
 * resources — in that dependency order.
 *
 * Also covered: an SSM parameter whose LOGICAL id is pinned via
 * overrideLogicalId while its construct PATH changes with the rename
 * (only Metadata's aws:cdk:path differs) — must be a no-op, not an update.
 *
 * covers: AWS::SQS::Queue
 * covers: AWS::DynamoDB::Table
 * covers: AWS::Lambda::Function
 * covers: AWS::Events::Rule
 * covers: AWS::Lambda::Permission
 * covers: AWS::SSM::Parameter
 */
export class RenameRefactorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updateMode = process.env.CDKD_TEST_UPDATE === 'true';
    // Construct-id suffix (the rename) + matching physical-name suffix so
    // verify.sh can address every generation deterministically.
    const cid = updateMode ? 'B' : 'A';
    const pfx = 'cdkd-rename-refactor';
    const sfx = updateMode ? 'b' : 'a';

    const queue = new sqs.Queue(this, `WorkQueue${cid}`, {
      queueName: `${pfx}-work-${sfx}`,
      visibilityTimeout: cdk.Duration.seconds(60),
    });

    const table = new dynamodb.Table(this, `Data${cid}`, {
      tableName: `${pfx}-data-${sfx}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const handler = new lambda.Function(this, `Handler${cid}`, {
      functionName: `${pfx}-handler-${sfx}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        'exports.handler = async () => ({ ok: true, queue: process.env.QUEUE_URL, table: process.env.TABLE_NAME });'
      ),
      environment: {
        QUEUE_URL: queue.queueUrl,
        TABLE_NAME: table.tableName,
      },
    });

    // Stable construct id AND stable physical name — survives the rename and
    // must be retargeted (in place) to the renamed lambda.
    const rule = new events.Rule(this, 'Tick', {
      ruleName: `${pfx}-tick`,
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
    });
    rule.addTarget(new targets.LambdaFunction(handler));

    // Logical id pinned; only the construct PATH (Metadata aws:cdk:path)
    // changes with the parent rename -> the deploy must treat it as a no-op.
    const holder = new Construct(this, `Holder${cid}`);
    const stable = new ssm.StringParameter(holder, 'Stable', {
      parameterName: `/cdkd-integ/${pfx}/stable`,
      stringValue: 'stable-value-unchanged',
    });
    (stable.node.defaultChild as ssm.CfnParameter).overrideLogicalId('StableParam');
  }
}
