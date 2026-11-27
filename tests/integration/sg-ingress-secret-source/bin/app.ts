#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SgIngressSecretSourceStack } from '../lib/sg-ingress-secret-source-stack.ts';

const app = new cdk.App();
new SgIngressSecretSourceStack(app, 'CdkdSgIngressSecretSourceExample', {
  description: 'cdkd integ: an ingress rule whose source is a secret reference (issue 7084)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
