#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattFallbackGuardStack } from '../lib/getatt-fallback-guard-stack.ts';

const app = new cdk.App();
new GetattFallbackGuardStack(app, 'CdkdGetattFallbackGuardExample', {
  description: 'cdkd Fn::GetAtt unknown-attribute ARN-shape guard error-path probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
