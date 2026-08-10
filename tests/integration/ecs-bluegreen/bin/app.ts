#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsBluegreenStack } from '../lib/ecs-bluegreen-stack.ts';

const app = new cdk.App();
new EcsBluegreenStack(app, 'CdkdEcsBluegreenExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
