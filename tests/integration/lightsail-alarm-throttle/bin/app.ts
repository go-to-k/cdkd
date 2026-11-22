#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LightsailAlarmThrottleStack } from '../lib/lightsail-alarm-throttle-stack.ts';

const app = new cdk.App();
new LightsailAlarmThrottleStack(app, 'CdkdLightsailAlarmThrottleExample', {
  description: 'cdkd Lightsail PutAlarm throttle integ probe (issue #6830)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
