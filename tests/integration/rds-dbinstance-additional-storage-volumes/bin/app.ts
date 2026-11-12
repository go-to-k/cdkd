#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsDbInstanceAdditionalStorageVolumesStack } from '../lib/rds-dbinstance-additional-storage-volumes-stack.ts';

const app = new cdk.App();
new RdsDbInstanceAdditionalStorageVolumesStack(
  app,
  'CdkdRdsDbInstanceAdditionalStorageVolumesExample',
  {
    description: 'cdkd RDS DBInstance AdditionalStorageVolumes integ probe (go-to-k/cdkd#5640)',
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  }
);
