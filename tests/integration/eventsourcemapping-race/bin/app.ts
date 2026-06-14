#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EsmRaceStack } from '../lib/eventsourcemapping-race-stack.ts';

const app = new cdk.App();
new EsmRaceStack(app, 'CdkdEsmRaceExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
