#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattCloudtrailAppsyncStack } from '../lib/getatt-cloudtrail-appsync-stack.ts';

const app = new cdk.App();
new GetattCloudtrailAppsyncStack(app, 'CdkdGetattCloudtrailAppsyncExample', {
  description: 'cdkd Fn::GetAtt CloudTrail SnsTopicArn and AppSync GraphQLEndpointArn / RealtimeUrl integ probe (issue #6242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
