#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  GsoProducerStack,
  GsoConsumerStack,
  PRODUCER_STACK_NAME,
  PRODUCER_REGION,
  CONSUMER_REGION,
} from '../lib/getstackoutput-crossregion-stack.ts';

const app = new cdk.App();

// Producer pinned to region X (us-west-2). cdkd deploys it with
// `--region us-west-2`; the explicit env here keeps the synth region
// consistent with the deploy region so the synthesized template's
// pseudo-parameters / ARNs match where it actually lands.
new GsoProducerStack(app, PRODUCER_STACK_NAME, {
  description: 'cdkd cross-region Fn::GetStackOutput integ producer (us-west-2)',
  env: { region: PRODUCER_REGION },
});

// Consumer pinned to region Y (us-east-1). Its Fn::GetStackOutput reads
// the producer's output from us-west-2 (cross-region, same account).
new GsoConsumerStack(app, 'CdkdGsoConsumer', {
  description: 'cdkd cross-region Fn::GetStackOutput integ consumer (us-east-1)',
  env: { region: CONSUMER_REGION },
});
