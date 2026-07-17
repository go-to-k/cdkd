#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgentcoreToolsStack } from '../lib/agentcore-tools-stack.ts';

const app = new cdk.App();
new AgentcoreToolsStack(app, 'CdkdAgentcoreToolsExample', {
  description: 'cdkd Bedrock AgentCore tools (Browser / CodeInterpreter / Evaluator) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
