#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { JournaledOrphanNetStack, JournaledOrphanStack } from '../lib/journaled-orphan-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
new JournaledOrphanNetStack(app, 'CdkdRpJournaledOrphanNet', {
  description: 'cdkd #4678 integ probe: the network the journaled load balancer sits in',
  env,
});
new JournaledOrphanStack(app, 'CdkdRpJournaledOrphanExample', {
  description: 'cdkd #4678 integ probe: a protected load balancer only the rollback journal records',
  env,
});
