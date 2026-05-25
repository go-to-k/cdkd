#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskAwsvpcStack } from '../lib/local-run-task-awsvpc-stack.ts';

const app = new cdk.App();

new LocalRunTaskAwsvpcStack(app, 'CdkdLocalRunTaskAwsvpcFixture', {
  description: 'Fixture stack for cdkd local run-task awsvpc-mode integ test',
});
