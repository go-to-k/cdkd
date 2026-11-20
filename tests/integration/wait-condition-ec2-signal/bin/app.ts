#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WaitConditionEc2SignalStack } from '../lib/wait-condition-ec2-signal-stack.ts';

const app = new cdk.App();
new WaitConditionEc2SignalStack(app, 'CdkdWaitConditionEc2Signal', {
  description: 'cdkd WaitCondition signalled from EC2 user data integ (issue 6694)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
