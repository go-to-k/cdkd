#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GlueSecurityConfigReplaceStack } from '../lib/glue-securityconfig-replace-stack.ts';

const app = new cdk.App();
new GlueSecurityConfigReplaceStack(app, 'CdkdGlueSecurityConfigReplaceExample', {
  description: 'cdkd --replace flag integ probe (immutable Glue SecurityConfiguration change)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
