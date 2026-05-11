#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskFromStateStack } from '../lib/local-run-task-from-state-stack';

const app = new cdk.App();

new LocalRunTaskFromStateStack(app, 'CdkdLocalRunTaskFromStateFixture', {
  description: 'Fixture stack for cdkd local run-task --from-state Tier 2 ECR Repository resolution integ test',
});
