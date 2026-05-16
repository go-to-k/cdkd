#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DeletionPolicyRetainStack } from '../lib/deletion-policy-retain-stack.ts';

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

new DeletionPolicyRetainStack(app, 'CdkdDeletionPolicyRetainExample', {
  description:
    'Two SSM Parameters — one RemovalPolicy.RETAIN, one RemovalPolicy.DESTROY — to verify cdkd destroy skips Retain resources.',
  env: { region },
});
