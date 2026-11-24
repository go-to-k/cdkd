#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NoWaitGetattRdsEndpointStack } from '../lib/no-wait-getatt-rds-endpoint-stack.ts';

const app = new cdk.App();
new NoWaitGetattRdsEndpointStack(app, 'CdkdNoWaitGetattRdsEndpointExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
