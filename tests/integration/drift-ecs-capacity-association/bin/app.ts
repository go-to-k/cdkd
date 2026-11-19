#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftEcsCapacityAssociationStack } from '../lib/drift-ecs-capacity-association-stack.ts';

const app = new cdk.App();
new DriftEcsCapacityAssociationStack(app, 'CdkdDriftEcsCapacityAssociationExample', {
  description: 'cdkd ECS capacity provider association drift integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
