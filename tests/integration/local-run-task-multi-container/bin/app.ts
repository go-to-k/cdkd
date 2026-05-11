#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskMultiStack } from '../lib/local-run-task-multi-stack';

const app = new cdk.App();

new LocalRunTaskMultiStack(app, 'CdkdLocalRunTaskMultiFixture', {
  description: 'Fixture stack for cdkd local run-task multi-container integ test',
});
