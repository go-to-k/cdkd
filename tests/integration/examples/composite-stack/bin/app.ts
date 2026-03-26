#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CompositeStack } from '../lib/composite-stack';

const app = new cdk.App();
new CompositeStack(app, 'CdkqCompositeStackExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
