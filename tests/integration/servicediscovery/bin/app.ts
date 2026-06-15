#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ServiceDiscoveryStack } from '../lib/servicediscovery-stack.ts';

const app = new cdk.App();
new ServiceDiscoveryStack(app, 'ServiceDiscoveryStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
