#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeFromStateStack } from '../lib/local-invoke-from-state-stack.ts';
import { LocalInvokeFromStateProducerStack } from '../lib/local-invoke-from-state-producer-stack.ts';
import { PRODUCER_STACK } from '../lib/shared.ts';

const app = new cdk.App();

new LocalInvokeFromStateProducerStack(app, PRODUCER_STACK, {
  description: 'Producer of a secret-bearing export for the cdkd local invoke --from-state integ test',
});

new LocalInvokeFromStateStack(app, 'CdkdLocalInvokeFromStateFixture', {
  description: 'Fixture stack for cdkd local invoke --from-state integ test',
});
