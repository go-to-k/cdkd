#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CreationPolicyCfnInitStack } from '../lib/creation-policy-cfn-init-stack.ts';

const app = new cdk.App();
new CreationPolicyCfnInitStack(app, 'CdkdCreationPolicyCfnInit', {
  description: 'cdkd CreationPolicy + cfn-init through the signal receiver integ (issue 6705)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
