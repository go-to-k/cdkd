#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MicroservicesStack } from '../lib/microservices-stack';

const app = new cdk.App();
new MicroservicesStack(app, 'MicroservicesStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
