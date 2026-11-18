#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcApiLookupStack } from '../lib/cc-api-lookup-stack.ts';

const app = new cdk.App();
new CcApiLookupStack(app, 'CdkdCcApiLookupExample', {
  description: 'cdkd cc-api-provider context lookup integ probe (#6542)',
  // Context lookups need a concrete account and region.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
