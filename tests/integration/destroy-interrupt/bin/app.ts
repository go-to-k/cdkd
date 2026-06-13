#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DestroyInterruptStack } from '../lib/destroy-interrupt-stack.ts';

const app = new cdk.App();
new DestroyInterruptStack(app, 'CdkdDestroyInterruptExample', {
  description:
    'Integ fixture for graceful-SIGINT destroy (#816) + Custom-Resource replay fail-fast (#804): VPC + 2 isolated subnets + S3 gateway endpoint + VPC-attached Lambda-backed Custom Resource + SSM Parameters. First Ctrl-C drains in-flight deletes, preserves state, releases the lock; re-run resumes cleanly with no 10-minute CR stall.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
