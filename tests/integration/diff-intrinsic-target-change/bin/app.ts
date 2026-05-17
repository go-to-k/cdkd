#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DiffIntrinsicTargetChangeStack } from '../lib/stack.ts';

const app = new cdk.App();

new DiffIntrinsicTargetChangeStack(app, 'CdkdDiffIntrinsicTargetChange', {
  description:
    'Regression: IAM policy Fn::GetAtt target rebound across refactor must be detected as UPDATE',
});
