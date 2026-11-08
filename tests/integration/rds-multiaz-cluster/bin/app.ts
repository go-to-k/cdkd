#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsMultiAzClusterStack } from '../lib/rds-multiaz-cluster-stack.ts';

const app = new cdk.App();
new RdsMultiAzClusterStack(app, 'CdkdRdsMultiAzClusterExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
