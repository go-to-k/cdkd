#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EventDrivenStack } from '../lib/event-driven-stack';

const app = new cdk.App();
new EventDrivenStack(app, 'EventDrivenStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
