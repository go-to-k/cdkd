#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattAppsyncS3expressS3tablesStack } from '../lib/getatt-appsync-s3express-s3tables-stack.ts';

const app = new cdk.App();
new GetattAppsyncS3expressS3tablesStack(app, 'CdkdGetattAppsyncS3expressS3tablesExample', {
  description: 'cdkd Fn::GetAtt AppSync / S3 Express / S3 Tables attribute integ probe (issue #6242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
