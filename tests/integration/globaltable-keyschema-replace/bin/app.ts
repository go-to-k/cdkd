#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlobalTableKeySchemaReplaceStack } from '../lib/globaltable-keyschema-replace-stack.ts';

const app = new cdk.App();
new GlobalTableKeySchemaReplaceStack(app, 'CdkdGlobalTableKeySchemaReplace', {
  description: 'cdkd GlobalTable KeySchema change replaced under --replace (issue #6363)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
