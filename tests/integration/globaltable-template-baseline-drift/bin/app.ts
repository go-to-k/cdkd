#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlobalTableTemplateBaselineDriftStack } from '../lib/globaltable-template-baseline-drift-stack.ts';

const app = new cdk.App();
new GlobalTableTemplateBaselineDriftStack(app, 'CdkdGlobalTableTemplateBaselineDrift', {
  description:
    'cdkd drift on a GlobalTable compared through its template bag reads AWS defaults and the AWS managed key as no drift (issues #5789, #5790)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
