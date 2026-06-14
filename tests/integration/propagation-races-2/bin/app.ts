#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PropagationRaces2Stack } from '../lib/propagation-races-2-stack.ts';

const app = new cdk.App();
new PropagationRaces2Stack(app, 'CdkdPropagationRaces2Example', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
