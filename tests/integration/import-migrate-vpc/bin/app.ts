#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportMigrateVpcStack } from '../lib/import-migrate-vpc-stack.ts';

const app = new cdk.App();
new ImportMigrateVpcStack(app, 'CdkdImportMigrateVpc', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
