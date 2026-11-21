#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AsgRollingSignalsStack } from '../lib/asg-rolling-signals-stack.ts';

const app = new cdk.App();
new AsgRollingSignalsStack(app, 'CdkdAsgRollingSignals', {
  description: 'cdkd ASG rolling update WaitOnResourceSignals through the signal receiver integ (issue 6706)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
