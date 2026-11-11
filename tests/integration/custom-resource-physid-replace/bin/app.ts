#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CrPhysidReplaceStack } from '../lib/cr-physid-replace-stack.ts';

const app = new cdk.App();
new CrPhysidReplaceStack(app, 'CdkdCrPhysidReplace', {
  description: 'cdkd deletes a custom resource old physical id after its Update replaces it (#6117)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
