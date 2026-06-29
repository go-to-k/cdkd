#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EfsImmutableReplacementStack } from '../lib/efs-immutable-replacement-stack.ts';

const app = new cdk.App();
new EfsImmutableReplacementStack(app, 'CdkdEfsImmutableReplacementExample', {
  description: 'cdkd createOnly replacement detection + stateful-replace guard integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
