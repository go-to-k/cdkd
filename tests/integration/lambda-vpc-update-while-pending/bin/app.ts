#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaVpcUpdateWhilePendingStack } from '../lib/lambda-vpc-update-while-pending-stack.ts';

const app = new cdk.App();
new LambdaVpcUpdateWhilePendingStack(app, 'CdkdLambdaVpcUpdateWhilePendingExample', {
  description: 'cdkd update of a VPC Lambda function that is still Pending (#6605)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
