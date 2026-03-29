#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EfsLambdaStack } from '../lib/efs-lambda-stack';

const app = new cdk.App();
new EfsLambdaStack(app, 'EfsLambdaStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
