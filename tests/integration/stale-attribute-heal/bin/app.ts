#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StaleAttributeHealStack } from '../lib/stale-attribute-heal-stack.ts';

const app = new cdk.App();

new StaleAttributeHealStack(app, 'CdkdStaleAttributeHealExample', {
  description:
    'cdkd fixture: a no-change deploy that adds a Fn::GetAtt on a record written before its attribute was recorded heals the record (issue #1852)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
