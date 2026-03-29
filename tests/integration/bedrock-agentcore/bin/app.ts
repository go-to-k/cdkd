#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BedrockAgentcoreStack } from '../lib/bedrock-agentcore-stack';

const app = new cdk.App();
new BedrockAgentcoreStack(app, 'BedrockAgentcoreStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
