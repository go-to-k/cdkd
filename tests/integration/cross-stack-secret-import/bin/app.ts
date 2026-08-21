#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChainConsumerStack } from '../lib/chain-consumer-stack.ts';
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

// The THIRD link (issue #2146): it imports the CONSUMER's re-export, so the
// secret reaches it two hops from the stack that declares the
// `{{resolve:secretsmanager:...}}` expression. Scrubbing THIS stack alone is
// what the issue is about — its recorded producer is the consumer, whose
// template carries no literal expression at all.
const chainConsumer = new ChainConsumerStack(app, 'CdkdCrossStackSecretChainConsumer', {
  description:
    'Chain consumer for issue 2146 integ test - imports the consumer stack re-export, two hops from the secret',
  env: { region },
});

// Same rationale as the edge above, one link further along: `cdk.Fn.importValue`
// is a synth-time token that propagates no stack dependency, so without this the
// DAG would let this stack race the consumer whose export it reads.
chainConsumer.addDependency(consumer);
