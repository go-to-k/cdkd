#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SgIngressSourceReplacementStack } from '../lib/sg-ingress-source-replacement-stack.ts';

const app = new cdk.App();
new SgIngressSourceReplacementStack(app, 'CdkdSgIngressSourceReplacementExample', {
  description: 'cdkd integ: a standalone ingress rule whose source changes is replaced (issue 7071)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
