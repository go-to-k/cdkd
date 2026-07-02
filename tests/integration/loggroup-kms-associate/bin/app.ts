#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LoggroupKmsAssociateStack } from '../lib/loggroup-kms-associate-stack.ts';

const app = new cdk.App();
new LoggroupKmsAssociateStack(app, 'CdkdLoggroupKmsAssociateExample', {
  description: 'cdkd LogGroup KmsKeyId in-place update (AssociateKmsKey / DisassociateKmsKey) integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
