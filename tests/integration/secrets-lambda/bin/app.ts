#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SecretsLambdaStack } from '../lib/secrets-lambda-stack';

const app = new cdk.App();
new SecretsLambdaStack(app, 'SecretsLambdaStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
