#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OrphanGetattTakeoverStack } from '../lib/orphan-getatt-takeover-stack.ts';

const app = new cdk.App();
new OrphanGetattTakeoverStack(app, 'CdkdOrphanGetattTakeoverExample', {
  description: 'cdkd orphan Fn::GetAtt substitution after a name takeover (issue #4186)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
