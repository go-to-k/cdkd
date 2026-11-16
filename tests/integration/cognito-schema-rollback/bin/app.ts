#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CognitoSchemaRollbackStack } from '../lib/cognito-schema-rollback-stack.ts';

const app = new cdk.App();
new CognitoSchemaRollbackStack(app, 'CdkdCognitoSchemaRollbackExample', {
  description: 'cdkd Cognito UserPool rollback over an added custom attribute integ probe (issue #6375)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
