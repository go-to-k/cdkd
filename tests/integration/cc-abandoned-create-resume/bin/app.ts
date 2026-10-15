#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcAbandonedCreateResumeStack } from '../lib/cc-abandoned-create-resume-stack.ts';

const app = new cdk.App();
new CcAbandonedCreateResumeStack(app, 'CdkdCcAbandonedCreateResume', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
