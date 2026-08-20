#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  RbXregionProducerStack,
  RbXregionConsumerStack,
  PRODUCER_STACK_NAME,
  CONSUMER_STACK_NAME,
  PRODUCER_REGION,
  CONSUMER_REGION,
} from '../lib/rollback-cross-region-secret-stack.ts';

const app = new cdk.App();

// Both stacks pinned to their own region: the synth region must match the
// deploy region so the cross-region read is genuinely cross-region.
new RbXregionProducerStack(app, PRODUCER_STACK_NAME, {
  description:
    'cdkd cross-region secret rollback integ producer (us-west-2) — exports a redacted SecureString dynamic reference',
  env: { region: PRODUCER_REGION },
});

new RbXregionConsumerStack(app, CONSUMER_STACK_NAME, {
  description:
    'cdkd cross-region secret rollback integ consumer (us-east-1) — reads the producer output cross-region; env-gated via MARKER_VALUE / INJECT_FAIL',
  env: { region: CONSUMER_REGION },
});
