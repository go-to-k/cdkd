#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbCognitoFromStateStack } from '../lib/local-start-alb-cognito-from-state-stack.ts';

const app = new cdk.App();

new LocalStartAlbCognitoFromStateStack(app, 'CdkdLocalStartAlbCognitoFromState', {
  description: 'Fixture stack for cdkd local start-alb --from-state behind an authenticate-cognito action',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
