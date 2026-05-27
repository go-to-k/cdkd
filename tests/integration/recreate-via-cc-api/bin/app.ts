#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecreateViaCcApiStack } from '../lib/recreate-stack.ts';

const app = new cdk.App();

new RecreateViaCcApiStack(app, 'CdkdRecreateViaCcApi', {
  description:
    'cdkd #615 --recreate-via-cc-api integ probe — mid-life SDK→CC migration via destroy+recreate',
});
