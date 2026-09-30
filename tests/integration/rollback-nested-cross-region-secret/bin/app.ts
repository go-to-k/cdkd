#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  RbNestedXregionProducerStack,
  RbNestedXregionConsumerStack,
  PRODUCER_STACK_NAME,
  CONSUMER_STACK_NAME,
  PRODUCER_REGION,
  CONSUMER_REGION,
} from '../lib/rollback-nested-cross-region-secret-stack.ts';

const app = new cdk.App();

// Both stacks pinned to their own region: the synth region must match the
// deploy region so the cross-region read is genuinely cross-region.
new RbNestedXregionProducerStack(app, PRODUCER_STACK_NAME, {
  description:
    'cdkd nested cross-region secret rollback integ producer (us-west-2) — exports a redacted SecureString dynamic reference',
  env: { region: PRODUCER_REGION },
});

new RbNestedXregionConsumerStack(app, CONSUMER_STACK_NAME, {
  description:
    'cdkd nested cross-region secret rollback integ consumer (us-east-1) — passes the cross-region read into a nested stack; env-gated via MARKER_VALUE / WITH_XREGION / INJECT_FAIL',
  env: { region: CONSUMER_REGION },
});
