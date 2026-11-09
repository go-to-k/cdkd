#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsDbInstanceProcessorFeaturesStack } from '../lib/rds-dbinstance-processor-features-stack.ts';

const app = new cdk.App();
new RdsDbInstanceProcessorFeaturesStack(app, 'CdkdRdsDbInstanceProcessorFeaturesExample', {
  description: 'cdkd RDS DBInstance ProcessorFeatures integ probe (go-to-k/cdkd#5640)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
