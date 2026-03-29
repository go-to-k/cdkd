#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RdsAuroraStack } from '../lib/rds-aurora-stack';

const app = new cdk.App();
new RdsAuroraStack(app, 'RdsAuroraStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
