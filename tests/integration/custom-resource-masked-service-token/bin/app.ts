#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CrMaskedServiceTokenStack } from '../lib/cr-masked-service-token-stack.ts';

const app = new cdk.App();
new CrMaskedServiceTokenStack(app, 'CdkdCrMaskedServiceTokenExample', {
  description: 'cdkd custom resource with a masked recorded ServiceToken integ probe (issue #3938)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
