#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportReimportMaskedAttrsStack } from '../lib/import-reimport-masked-attrs-stack.ts';

const app = new cdk.App();
new ImportReimportMaskedAttrsStack(app, 'CdkdImportReimportMaskedAttrsExample', {
  description: 'cdkd re-import keeps recorded attribute values over masks (issue #2927)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
