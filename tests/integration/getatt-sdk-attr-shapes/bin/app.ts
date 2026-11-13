#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetAttSdkAttrShapesStack } from '../lib/getatt-sdk-attr-shapes-stack.ts';

const app = new cdk.App();
new GetAttSdkAttrShapesStack(app, 'CdkdGetAttSdkAttrShapes', {
  description: 'cdkd Fn::GetAtt read-only attribute shapes on SDK providers integ (go-to-k/cdkd#6238)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
