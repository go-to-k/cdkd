#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartMicrovmFromStateStack } from '../lib/local-start-microvm-from-state-stack.ts';

const app = new cdk.App();

new LocalStartMicrovmFromStateStack(app, 'CdkdLocalStartMicrovmFromState', {
  description: 'Fixture stack for cdkd local start-microvm --from-state integ test',
  env: { region: 'us-east-1' },
});
