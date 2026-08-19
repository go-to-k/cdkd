#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoStack } from '../lib/cognito-stack.ts';
import { CognitoPreflightStack } from '../lib/cognito-preflight-stack.ts';

const app = new cdk.App();
new CognitoStack(app, 'CognitoStack', {
  description: 'cdkd Cognito example with UserPool',
});

// The MFA pre-flight refusal arms (issues #1975 / #1977). A SEPARATE stack
// because its update deploy must FAIL, while CognitoStack's must succeed —
// see the stack's own doc comment.
new CognitoPreflightStack(app, 'CognitoPreflightStack', {
  description: 'cdkd Cognito MFA pre-flight refusal arms (#1975 / #1977)',
});
