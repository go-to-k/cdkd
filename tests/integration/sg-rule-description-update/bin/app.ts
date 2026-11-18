#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SgRuleDescriptionUpdateStack } from '../lib/sg-rule-description-update-stack.ts';

const app = new cdk.App();
new SgRuleDescriptionUpdateStack(app, 'CdkdSgRuleDescriptionUpdateExample', {
  description: 'cdkd integ: security group rule description edits are applied in place (issue 6514)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
