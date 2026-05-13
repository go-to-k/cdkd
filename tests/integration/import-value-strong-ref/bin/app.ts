#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack } from '../lib/producer-stack.ts';
import { ConsumerStack } from '../lib/consumer-stack.ts';

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const producer = new ProducerStack(app, 'CdkdImportValueProducer', {
  description: 'Producer stack for Issue #343 integ test — exports BucketArn',
  env: { region },
});

const consumer = new ConsumerStack(app, 'CdkdImportValueConsumer', {
  description: 'Consumer stack for Issue #343 integ test — imports BucketArn',
  env: { region },
});

// Explicit cross-stack dependency: `cdk.Fn.importValue` is a string-token
// shortcut that does NOT auto-propagate a stack dependency to the
// containing stack (because no CDK Resource reference flows between the
// two stacks — the import is a synth-time intrinsic, not a JS reference).
// cdkd's `deploy --all` DAG ordering follows CDK's stack manifest, which
// would otherwise report no dependency and deploy them in parallel,
// racing Consumer's Fn::ImportValue resolve against the Producer state
// that has not been written yet. addDependency() forces the manifest
// to record producer-before-consumer.
consumer.addDependency(producer);
