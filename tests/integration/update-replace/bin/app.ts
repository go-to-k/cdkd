#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UpdateReplaceStack } from '../lib/update-replace-stack.ts';

const app = new cdk.App();

// env is required because the stack uses ec2.Vpc.fromLookup (default VPC)
// and derives globally-unique physical names from account + region. Both
// come from the standard CDK_DEFAULT_* env vars cdkd's synthesis layer sets.
new UpdateReplaceStack(app, 'CdkdUpdateReplaceExample', {
  description: 'cdkd UPDATE / replacement breadth example',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
