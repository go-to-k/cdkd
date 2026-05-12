#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcrStack } from '../lib/ecr-stack.ts';

const app = new cdk.App();
new EcrStack(app, 'EcrStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
