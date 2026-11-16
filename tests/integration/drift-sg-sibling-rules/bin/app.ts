#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftSgSiblingRulesStack } from '../lib/drift-sg-sibling-rules-stack.ts';

const app = new cdk.App();
new DriftSgSiblingRulesStack(app, 'CdkdDriftSgSiblingRulesExample', {
  description: 'cdkd security-group sibling rule drift integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
