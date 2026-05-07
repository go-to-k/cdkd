#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DriftRevertStack } from '../lib/drift-revert-stack';

const app = new cdk.App();

new DriftRevertStack(app, 'CdkdDriftRevertExample', {
  description: 'End-to-end real-AWS test fixture for cdkd drift + cdkd drift --revert',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
