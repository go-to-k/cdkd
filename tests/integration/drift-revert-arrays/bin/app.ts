#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftRevertArraysStack } from '../lib/drift-revert-arrays-stack.ts';

const app = new cdk.App();

new DriftRevertArraysStack(app, 'CdkdDriftArraysExample', {
  description:
    'End-to-end real-AWS test fixture for cdkd drift + cdkd drift --revert against tag-heavy / array-heavy resource types (issue #802 canonicalization)',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
