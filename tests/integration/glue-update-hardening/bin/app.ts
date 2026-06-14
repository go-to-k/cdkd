#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlueUpdateHardeningStack } from '../lib/glue-update-hardening-stack.ts';

const app = new cdk.App();
new GlueUpdateHardeningStack(app, 'GlueUpdateHardeningStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
