#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportAttributeReadbackNetworkStack } from '../lib/import-attribute-readback-network-stack.ts';

const app = new cdk.App();
new ImportAttributeReadbackNetworkStack(app, 'CdkdImportAttrReadbackNet', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
