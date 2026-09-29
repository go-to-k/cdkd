#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NoechoParameterMaskingStack } from '../lib/noecho-parameter-masking-stack.ts';

const app = new cdk.App();
new NoechoParameterMaskingStack(app, 'CdkdNoechoParameterMaskingExample', {
  description: 'cdkd NoEcho template parameter masking integ probe (issue #1998)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
