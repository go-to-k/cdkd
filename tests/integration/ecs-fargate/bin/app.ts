#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EcsFargateStack } from '../lib/ecs-fargate-stack';

const app = new cdk.App();
new EcsFargateStack(app, 'EcsFargateStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
