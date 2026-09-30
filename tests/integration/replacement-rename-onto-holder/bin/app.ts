#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplacementRenameOntoHolderStack } from '../lib/replacement-rename-onto-holder-stack.ts';

const app = new cdk.App();
new ReplacementRenameOntoHolderStack(app, 'CdkdReplacementRenameOntoHolderExample', {
  description: 'cdkd replacement renamed onto a held name integ probe (issues #3931, #3937)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
