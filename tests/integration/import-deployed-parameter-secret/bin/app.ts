#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportDeployedParameterSecretStack } from '../lib/import-deployed-parameter-secret-stack.ts';

const app = new cdk.App();
new ImportDeployedParameterSecretStack(app, 'CdkdImportDeployedParamSecret', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
