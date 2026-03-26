#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/cognito-stack';

const app = new cdk.App();
new CognitoStack(app, 'CognitoStack', {
  description: 'cdkd Cognito example with UserPool',
});
