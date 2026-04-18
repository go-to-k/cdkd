#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { VpcLookupStack } from '../lib/vpc-lookup-stack';

const app = new cdk.App();

new VpcLookupStack(app, 'CdkdVpcLookupTest', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
