import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

export const PFX = 'cdkd-refactor-move';

interface MoveProps extends cdk.StackProps {
  /** Generation "b": the table and the queue live in the destination stack. */
  moved: boolean;
}

function addMovedResources(scope: Construct): { table: dynamodb.Table; queue: sqs.Queue } {
  const table = new dynamodb.Table(scope, 'Table', {
    tableName: `${PFX}-data`,
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const queue = new sqs.Queue(scope, 'Queue', { visibilityTimeout: cdk.Duration.seconds(45) });
  return { table, queue };
}

/**
 * The destination: a topic in both generations (so it already holds cdkd
 * state when the move happens), plus the table and the queue in generation b.
 */
export class DestStack extends cdk.Stack {
  readonly queue?: sqs.Queue;
  readonly table?: dynamodb.Table;

  constructor(scope: Construct, id: string, props: MoveProps) {
    super(scope, id, props);
    new sns.Topic(this, 'Anchor');
    if (props.moved) {
      const { table, queue } = addMovedResources(this);
      this.table = table;
      this.queue = queue;
    }
  }
}

/**
 * The source: the table and the queue in generation a, and in both
 * generations an SSM parameter recording them -- local references in
 * generation a, cross-stack imports from the destination in generation b.
 */
export class SourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MoveProps & { dest: DestStack }) {
    super(scope, id, props);
    let table: dynamodb.Table;
    let queue: sqs.Queue;
    if (props.moved) {
      table = props.dest.table!;
      queue = props.dest.queue!;
    } else {
      ({ table, queue } = addMovedResources(this));
    }
    new ssm.StringParameter(this, 'Wiring', {
      parameterName: `/cdkd-integ/${PFX}/wiring`,
      stringValue: cdk.Fn.join('|', [queue.queueUrl, table.tableName]),
    });
  }
}
