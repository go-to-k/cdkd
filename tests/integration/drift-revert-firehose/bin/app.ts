#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftRevertFirehoseStack } from '../lib/drift-revert-firehose-stack.ts';

const app = new cdk.App();
new DriftRevertFirehoseStack(app, 'CdkdDriftRevertFirehoseExample', {
  description: 'cdkd drift --revert on S3-destination Firehose delivery streams integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
