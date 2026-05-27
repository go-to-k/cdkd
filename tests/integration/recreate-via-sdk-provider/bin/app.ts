#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecreateViaSdkProviderStack } from '../lib/recreate-stack.ts';

const app = new cdk.App();

new RecreateViaSdkProviderStack(app, 'CdkdRecreateViaSdkProvider', {
  description:
    'cdkd #651 --recreate-via-sdk-provider integ probe — mid-life CC→SDK migration via destroy+recreate',
});
