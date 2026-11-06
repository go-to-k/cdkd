#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AppConfigEnvironmentDeleteProtectionStack } from '../lib/appconfig-environment-delete-protection-stack.ts';

const app = new cdk.App();
new AppConfigEnvironmentDeleteProtectionStack(app, 'CdkdAppConfigEnvDelProtExample', {
  description: 'cdkd AppConfig Environment DeletionProtectionCheck BYPASS integ (#5875)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
