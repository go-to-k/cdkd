#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FailingChildParentStack } from '../lib/nested-child-first-deploy-failure-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
// A parent holding a resource of its own (the destroy's main path) and one
// holding only the nested row (the empty-record path).
new FailingChildParentStack(app, 'CdkdIntegNestedChildFail', {
  description: 'cdkd nested child first-deploy failure integ (parent with a resource)',
  env,
  parentResource: true,
});
new FailingChildParentStack(app, 'CdkdIntegNestedChildFailEmpty', {
  description: 'cdkd nested child first-deploy failure integ (parent with only the row)',
  env,
  parentResource: false,
});
