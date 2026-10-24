#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TerminationProtectionStack } from '../lib/termination-protection-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
new TerminationProtectionStack(app, 'CdkdTerminationProtection', { env });
