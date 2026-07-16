#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GcCustomAssetNamesStack } from '../lib/gc-custom-asset-names-stack.ts';

const app = new cdk.App();
new GcCustomAssetNamesStack(app, 'CdkdGcCustomAssetNamesExample', {
  description:
    'cdkd integ: file-asset publish into CUSTOM-named cdkd asset storage + cdkd gc lifecycle (issue #1026)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
