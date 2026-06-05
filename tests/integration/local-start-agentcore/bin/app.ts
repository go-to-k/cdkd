#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAgentCoreStack } from '../lib/local-start-agentcore-stack.ts';

const app = new cdk.App();

new LocalStartAgentCoreStack(app, 'CdkLocalStartAgentCoreFixture', {
  description: 'Fixture stack for cdkd local start-agentcore integ test',
});
