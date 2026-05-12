#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BedrockAgentcoreStack } from '../lib/bedrock-agentcore-stack.ts';

const app = new cdk.App();
new BedrockAgentcoreStack(app, 'BedrockAgentcoreStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
