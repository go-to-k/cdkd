#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConsumerStack } from '../lib/consumer-stack.ts';
import { ProducerStack } from '../lib/producer-stack.ts';

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const producer = new ProducerStack(app, 'CdkdCrossStackSecretProducer', {
  description:
    'Producer stack for issue 1934 integ test - exports a secret-bearing output whose value is a Secrets Manager dynamic reference',
  env: { region },
});

const consumer = new ConsumerStack(app, 'CdkdCrossStackSecretConsumer', {
  description:
    'Consumer stack for issue 1934 integ test - imports the secret-bearing export into an SSM parameter',
  env: { region },
});

// Explicit cross-stack dependency: `cdk.Fn.importValue` is a synth-time string
// token and does NOT propagate a stack dependency to the containing stack (no
// CDK Resource reference flows between the two stacks). cdkd's `deploy --all`
// DAG ordering follows CDK's stack manifest, which would otherwise report no
// dependency and deploy both in parallel, racing the consumer's
// `Fn::ImportValue` resolve against a producer whose state / exports index has
// not been written yet. Same rationale as the `import-value-strong-ref` and
// `outputs-only-export` fixtures.
consumer.addDependency(producer);
