#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NoWaitAgentcoreRuntimeEndpointStack } from '../lib/no-wait-agentcore-runtime-endpoint-stack.ts';

const app = new cdk.App();
new NoWaitAgentcoreRuntimeEndpointStack(app, 'CdkdNoWaitAgentcoreRuntimeEndpointExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
