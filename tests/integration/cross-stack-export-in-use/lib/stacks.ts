import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

interface PhaseProps extends cdk.StackProps {
  updated: boolean;
}

/** Exports a queue's ARN and URL (CDK's automatic strong references). */
export class ProducerStack extends cdk.Stack {
  readonly queue: sqs.Queue;
  constructor(scope: Construct, id: string, props: PhaseProps) {
    super(scope, id, props);
    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: props.updated ? 'cdkd-integ-export-in-use-q2' : 'cdkd-integ-export-in-use-q1',
    });
  }
}

/** Imports the queue's ARN and URL into two SSM parameters. */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { queue: sqs.Queue }) {
    super(scope, id, props);
    new ssm.StringParameter(this, 'QueueArn', {
      parameterName: '/cdkd-integ/export-in-use/queue-arn',
      stringValue: props.queue.queueArn,
    });
    new ssm.StringParameter(this, 'QueueUrl', {
      parameterName: '/cdkd-integ/export-in-use/queue-url',
      stringValue: props.queue.queueUrl,
    });
  }
}

/** Phase 1 exports a bucket's name; phase 2 drops the bucket and the export. */
export class EmbraceProducerStack extends cdk.Stack {
  readonly bucket?: s3.Bucket;
  constructor(scope: Construct, id: string, props: PhaseProps) {
    super(scope, id, props);
    new ssm.StringParameter(this, 'Keep', {
      parameterName: '/cdkd-integ/export-in-use/embrace-keep',
      stringValue: 'keep',
    });
    if (!props.updated) {
      this.bucket = new s3.Bucket(this, 'Bucket', { removalPolicy: cdk.RemovalPolicy.DESTROY });
    }
  }
}

/** Phase 1 imports the bucket name; phase 2 inlines a literal instead. */
export class EmbraceConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { bucketName?: string }) {
    super(scope, id, props);
    new ssm.StringParameter(this, 'BucketName', {
      parameterName: '/cdkd-integ/export-in-use/embrace-bucket',
      stringValue: props.bucketName ?? 'inlined',
    });
  }
}
