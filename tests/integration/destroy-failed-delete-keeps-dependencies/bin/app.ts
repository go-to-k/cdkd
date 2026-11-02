#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DestroyFailedDeleteKeepsDependenciesStack } from '../lib/destroy-failed-delete-keeps-dependencies-stack.ts';

const app = new cdk.App();
new DestroyFailedDeleteKeepsDependenciesStack(app, 'CdkdDestroyFailedDeleteKeepsDepsExample', {
  description: 'cdkd destroy keeps the dependencies of a failed delete integ probe (issue #5670)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
