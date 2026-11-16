#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AsgDestroyRunningInstancesStack } from '../lib/asg-destroy-running-instances-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
new AsgDestroyRunningInstancesStack(app, 'CdkdAsgDestroyRunningExample', {
  description: 'cdkd destroy of an ASG with a running instance integ probe (issue #6466)',
  env,
  protectedFromScaleIn: false,
});
new AsgDestroyRunningInstancesStack(app, 'CdkdAsgDestroyScaleInProtectedExample', {
  description: 'cdkd destroy of an ASG whose instance is protected from scale in (issue #6466)',
  env,
  protectedFromScaleIn: true,
});
