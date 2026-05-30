#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAgentCoreStack } from '../lib/local-invoke-agentcore-stack.ts';

const app = new cdk.App();

new LocalInvokeAgentCoreStack(app, 'CdkLocalInvokeAgentCoreFixture', {
  description: 'Fixture stack for cdkd local invoke-agentcore integ test',
});
