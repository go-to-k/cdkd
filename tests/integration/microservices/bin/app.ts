#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MicroservicesStack } from '../lib/microservices-stack.ts';

const app = new cdk.App();
new MicroservicesStack(app, 'MicroservicesStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
