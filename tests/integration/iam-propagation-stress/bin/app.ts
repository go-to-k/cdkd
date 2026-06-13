#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamPropagationStressStack } from '../lib/iam-propagation-stress-stack.ts';

const app = new cdk.App();
new IamPropagationStressStack(app, 'CdkdIamPropagationStressExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
