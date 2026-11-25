#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ReplacedUserOfRemovedStack } from '../lib/replaced-user-of-removed-resource-stack.ts';

const app = new cdk.App();
new ReplacedUserOfRemovedStack(app, 'CdkdReplacedUserOfRemovedExample', {
  description: 'cdkd replaced old copy using a removed resource is deleted first integ (issue #6977)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
