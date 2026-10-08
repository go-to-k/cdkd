#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  JournaledOrphanNestedStack,
  JournaledOrphanNetStack,
  JournaledOrphanStack,
} from '../lib/journaled-orphan-stack.ts';

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
new JournaledOrphanNestedStack(app, 'CdkdRpJournaledOrphanNested', {
  description:
    'cdkd #4703 integ probe: a protected load balancer the failed deploy created inside an existing nested stack',
  env,
});
