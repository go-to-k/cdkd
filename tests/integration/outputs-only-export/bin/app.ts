#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack } from '../lib/producer-stack.ts';
import { ConsumerStack } from '../lib/consumer-stack.ts';

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

// Phase toggle: when CDKD_TEST_WITH_CONSUMER=true the consumer stack exists
// AND the producer adds its export. When unset the producer deploys the SAME
// bucket but with no output/export. Flipping the flag between two producer
// deploys is the Outputs-only change Issue #875 is about.
const withConsumer = process.env.CDKD_TEST_WITH_CONSUMER === 'true';

const producer = new ProducerStack(app, 'CdkdOutputsOnlyProducer', {
  description: 'Producer stack for Issue #875 integ test — exports BucketArn only with consumer',
  exportArn: withConsumer,
  env: { region },
});

if (withConsumer) {
  const consumer = new ConsumerStack(app, 'CdkdOutputsOnlyConsumer', {
    description: 'Consumer stack for Issue #875 integ test — imports BucketArn',
    env: { region },
  });

  // `cdk.Fn.importValue` is a synth-time string token and does NOT auto-create
  // a stack dependency, so force producer-before-consumer ordering for
  // `deploy --all` (same rationale as the import-value-strong-ref fixture).
  consumer.addDependency(producer);
}
