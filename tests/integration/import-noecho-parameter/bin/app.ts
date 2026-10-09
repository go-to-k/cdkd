#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportNoEchoParameterStack } from '../lib/import-noecho-parameter-stack.ts';

const app = new cdk.App();
new ImportNoEchoParameterStack(app, 'CdkdImportNoEchoParameterExample', {
  description: 'cdkd import of a NoEcho parameter position (go-to-k/cdkd#4043)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
