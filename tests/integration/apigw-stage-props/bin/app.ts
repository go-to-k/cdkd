#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApigwStagePropsStack } from '../lib/apigw-stage-props-stack.ts';

const app = new cdk.App();
new ApigwStagePropsStack(app, 'CdkdApigwStagePropsExample', {
  description:
    'AWS::ApiGateway::Stage silent-drop property backfill: AccessLogSetting, CanarySetting, ClientCertificateId (issue #609)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
