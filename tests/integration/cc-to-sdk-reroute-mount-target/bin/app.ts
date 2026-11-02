#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcToSdkRerouteMountTargetStack } from '../lib/cc-to-sdk-reroute-mount-target-stack.ts';

const app = new cdk.App();
new CcToSdkRerouteMountTargetStack(app, 'CdkdCcToSdkRerouteMountTargetExample', {
  description: 'cdkd sticky-CC to SDK re-route parity integ for AWS::EFS::MountTarget (issue 5641)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
