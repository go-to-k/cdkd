#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { KmsEncryptionStack } from '../lib/kms-encryption-stack';

const app = new cdk.App();
new KmsEncryptionStack(app, 'KmsEncryptionStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
