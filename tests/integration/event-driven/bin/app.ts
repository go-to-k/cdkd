#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EventDrivenStack } from '../lib/event-driven-stack.ts';

const app = new cdk.App();
new EventDrivenStack(app, 'EventDrivenStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
