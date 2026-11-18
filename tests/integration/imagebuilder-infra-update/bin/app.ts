#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImageBuilderInfraUpdateStack } from '../lib/imagebuilder-infra-update-stack.ts';

const app = new cdk.App();
new ImageBuilderInfraUpdateStack(app, 'CdkdImageBuilderInfraUpdate', {
  description: 'cdkd Image Builder infrastructure configuration update (issue #6569)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
