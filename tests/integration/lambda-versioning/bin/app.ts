#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LambdaVersioningStack } from '../lib/lambda-versioning-stack';

const app = new cdk.App();
new LambdaVersioningStack(app, 'LambdaVersioningStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
