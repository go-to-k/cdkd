#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SsmDocumentReplaceStack } from '../lib/ssm-document-replace-stack.ts';

const app = new cdk.App();
new SsmDocumentReplaceStack(app, 'CdkdSsmDocumentReplace', {
  description: 'cdkd SSM document content change under each UpdateMethod (issue #6568)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
