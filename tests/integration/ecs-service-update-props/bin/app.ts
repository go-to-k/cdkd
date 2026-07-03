#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsServiceUpdatePropsStack } from '../lib/ecs-service-update-props-stack.ts';

const app = new cdk.App();
new EcsServiceUpdatePropsStack(app, 'EcsServiceUpdatePropsStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
