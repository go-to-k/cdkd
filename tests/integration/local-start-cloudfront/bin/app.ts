#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontStack } from '../lib/local-start-cloudfront-stack.ts';

const app = new cdk.App();

new LocalStartCloudFrontStack(app, 'CdkdLocalStartCloudFrontFixture', {
  description: 'Fixture stack for cdkd local start-cloudfront integ test',
});
