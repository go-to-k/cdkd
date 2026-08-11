#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CloudTrailTrailStack } from '../lib/cloudtrail-trail-stack.ts';

const app = new cdk.App();

new CloudTrailTrailStack(app, 'CdkdCloudTrailTrailExample', {
  description:
    'Verifies CloudTrailProvider removal resets + the CFn-retained CloudWatch Logs pair (issue #1160)',
  env: { region: 'us-east-1' },
});
