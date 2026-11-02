#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsGatewayRolePropagationStack } from '../lib/ecs-gateway-role-propagation-stack.ts';

const app = new cdk.App();
new EcsGatewayRolePropagationStack(app, 'CdkdEcsGatewayRolePropagationExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
