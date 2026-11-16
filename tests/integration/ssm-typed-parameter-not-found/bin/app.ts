#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SsmTypedParameterNotFoundStack } from '../lib/ssm-typed-parameter-not-found-stack.ts';

const app = new cdk.App();
new SsmTypedParameterNotFoundStack(app, 'CdkdSsmTypedParameterNotFoundExample', {
  description: 'cdkd deploy naming a missing SSM-typed template parameter integ probe (issue #6380)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
