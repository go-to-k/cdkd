#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartMicrovmStack } from '../lib/local-start-microvm-stack.ts';

const app = new cdk.App();

new LocalStartMicrovmStack(app, 'CdkdLocalStartMicrovmFixture', {
  description: 'Fixture stack for cdkd local start-microvm integ test',
});
