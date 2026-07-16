#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SesIdentityStack } from '../lib/ses-identity-stack.ts';

const app = new cdk.App();
new SesIdentityStack(app, 'CdkdSesIdentityExample', {
  description: 'cdkd SES EmailIdentity + ConfigurationSet integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
