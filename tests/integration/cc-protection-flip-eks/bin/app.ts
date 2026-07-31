#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcProtectionFlipEksStack } from '../lib/cc-protection-flip-eks-stack.ts';

const app = new cdk.App();
new CcProtectionFlipEksStack(app, 'CdkdCcProtectionFlipEksExample', {
  description: 'cdkd CC protection flip integ for AWS::EKS::Cluster (issue #1315)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
