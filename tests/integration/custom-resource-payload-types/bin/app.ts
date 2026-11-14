#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CrPayloadTypesStack } from '../lib/cr-payload-types-stack.ts';

const app = new cdk.App();
new CrPayloadTypesStack(app, 'CdkdCrPayloadTypes', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
