#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RemoveProtectionStack } from '../lib/remove-protection-stack';

const app = new cdk.App();

new RemoveProtectionStack(app, 'CdkdRemoveProtectionExample', {
  description:
    'End-to-end real-AWS test fixture for cdkd destroy --remove-protection',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
