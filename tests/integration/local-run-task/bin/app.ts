#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskStack } from '../lib/local-run-task-stack';

const app = new cdk.App();

new LocalRunTaskStack(app, 'CdkdLocalRunTaskFixture', {
  description: 'Fixture stack for cdkd local run-task integ test',
});
