#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/cognito-stack.ts';

const app = new cdk.App();
new CognitoStack(app, 'CognitoStack', {
  description: 'cdkd Cognito example with UserPool',
});
