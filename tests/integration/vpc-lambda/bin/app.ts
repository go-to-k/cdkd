#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcLambdaStack } from '../lib/vpc-lambda-stack';

const app = new cdk.App();
new VpcLambdaStack(app, 'VpcLambdaStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
