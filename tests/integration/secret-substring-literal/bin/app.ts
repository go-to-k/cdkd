#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretSubstringLiteralStack } from '../lib/secret-substring-literal-stack.ts';

const app = new cdk.App();
new SecretSubstringLiteralStack(app, 'CdkdSecretSubstringLiteral', {
  description:
    'A plain template literal that contains a generated secret username stays a literal in state (issue #6303)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
