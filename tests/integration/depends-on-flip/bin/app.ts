#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DependsOnFlipStack } from '../lib/depends-on-flip-stack.ts';

const app = new cdk.App();
new DependsOnFlipStack(app, 'CdkdDependsOnFlipExample', {
  description: 'cdkd reversed explicit dependency redeploy + destroy integ probe (issue #6308)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
