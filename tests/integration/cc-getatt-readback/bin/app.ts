#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcGetattReadbackStack } from '../lib/cc-getatt-readback-stack.ts';

const app = new cdk.App();
new CcGetattReadbackStack(app, 'CdkdCcGetattReadbackExample', {
  description:
    'cdkd CC-routed Fn::GetAtt read-back enrichment integ probe (Pipes / S3 AccessPoint / ResourceGroups)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
