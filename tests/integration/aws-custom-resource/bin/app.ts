#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsCustomResourceStack } from '../lib/aws-custom-resource-stack.ts';

const app = new cdk.App();
new AwsCustomResourceStack(app, 'CdkdAwsCustomResourceExample', {
  description: 'cdkd AwsCustomResource (Custom::AWS) onCreate/onUpdate/onDelete integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
