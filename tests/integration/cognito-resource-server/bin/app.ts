#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoResourceServerStack } from '../lib/cognito-resource-server-stack.ts';

const app = new cdk.App();
new CognitoResourceServerStack(app, 'CognitoResourceServerStack', {
  description:
    'cdkd Cognito resource-server scope reference (compound-id Ref) integ',
});
