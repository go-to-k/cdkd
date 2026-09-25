#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { UnrecognizedKeyAutorouteStack } from '../lib/unrecognized-key-autoroute-stack.ts';

const app = new cdk.App();
new UnrecognizedKeyAutorouteStack(app, 'CdkdUnrecognizedKeyAutorouteExample', {
  description: 'cdkd routes a key absent from the CFn schema snapshot via Cloud Control (issue 3713)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
