import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
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
    // Named after the imported queue name: the producer's replacement replaces
    // it, which `cdkd diff` over both stacks must show (go-to-k/cdkd#6796).
    new iam.CfnRole(this, 'NamedByQueue', {
      roleName: `cdkd-integ-eiu-${props.queue.queueName}`,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
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

/**
 * go-to-k/cdkd#6865: a custom resource re-run on every deploy (a fresh
 * `Timestamp`) whose returned `Value` is exported. `CDKD_TEST_CR_VALUE` picks
 * what the handler returns (`v1` by default).
 */
export class CrProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const onEvent = new lambda.Function(this, 'OnEvent', {
      functionName: 'cdkd-integ-eiu-cr-on-event',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    props = event.get('ResourceProperties', {})
    print('REQUEST ' + event.get('RequestType', '') + ' ' + str(props.get('Timestamp')) + ' ' + str(props.get('Ret')))
    return {'PhysicalResourceId': 'cdkd-integ-eiu-cr', 'Data': {'Value': props.get('Ret', '')}}
`),
      timeout: cdk.Duration.seconds(30),
    });
    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEvent,
      providerFunctionName: 'cdkd-integ-eiu-cr-provider',
    });
    const resource = new cdk.CustomResource(this, 'Cr', {
      serviceToken: provider.serviceToken,
      properties: {
        Timestamp: Date.now().toString(),
        Ret: process.env.CDKD_TEST_CR_VALUE ?? 'v1',
      },
    });
    new cdk.CfnOutput(this, 'CrValue', {
      value: resource.getAttString('Value'),
      exportName: 'CdkdExportInUseCrValue',
    });
  }
}

/** Imports the custom resource's exported value into an SSM parameter. */
export class CrConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    new ssm.StringParameter(this, 'CrValue', {
      parameterName: '/cdkd-integ/export-in-use/cr-value',
      stringValue: cdk.Fn.importValue('CdkdExportInUseCrValue'),
    });
  }
}
