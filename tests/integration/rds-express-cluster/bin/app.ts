#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsExpressClusterStack } from '../lib/rds-express-cluster-stack.ts';

const app = new cdk.App();
new RdsExpressClusterStack(app, 'CdkdRdsExpressClusterExample', {
  description: 'cdkd RDS DBCluster WithExpressConfiguration integ probe (go-to-k/cdkd#5984)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
