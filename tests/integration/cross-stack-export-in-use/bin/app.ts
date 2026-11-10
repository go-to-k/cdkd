#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConsumerStack, EmbraceConsumerStack, EmbraceProducerStack, ProducerStack } from '../lib/stacks.ts';

const app = new cdk.App();
const env = { region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1' };
// CDKD_TEST_UPDATE=true is phase 2: the producer's queue is renamed (a
// replacement, so its exported ARN and URL change) and the embrace pair drops
// both the consumer's reference and the producer's bucket.
const updated = process.env.CDKD_TEST_UPDATE === 'true';

const producer = new ProducerStack(app, 'CdkdExportInUseProd', { env, updated });
new ConsumerStack(app, 'CdkdExportInUseCons', { env, queue: producer.queue });

const embraceProducer = new EmbraceProducerStack(app, 'CdkdExportInUseEmbraceProd', { env, updated });
new EmbraceConsumerStack(app, 'CdkdExportInUseEmbraceCons', {
  env,
  bucketName: embraceProducer.bucket?.bucketName,
});
