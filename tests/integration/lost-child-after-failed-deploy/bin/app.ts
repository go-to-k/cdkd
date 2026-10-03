#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LostChildAfterFailedDeployStack } from '../lib/lost-child-after-failed-deploy-stack.ts';

const app = new cdk.App();
new LostChildAfterFailedDeployStack(app, 'CdkdLostChildAfterFailedDeployExample', {
  description: 'cdkd restores a bucket policy lost with a failed same-id recreate (issue #4443)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
