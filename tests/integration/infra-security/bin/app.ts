#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InfraSecurityStack } from '../lib/infra-security-stack.ts';

const app = new cdk.App();
new InfraSecurityStack(app, 'InfraSecurityStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
