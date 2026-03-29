#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { InfraSecurityStack } from '../lib/infra-security-stack';

const app = new cdk.App();
new InfraSecurityStack(app, 'InfraSecurityStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
