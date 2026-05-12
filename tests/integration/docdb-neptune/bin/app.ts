#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DocdbNeptuneStack } from '../lib/docdb-neptune-stack.ts';

const app = new cdk.App();

new DocdbNeptuneStack(app, 'CdkdDocdbNeptuneExample', {
  description:
    'End-to-end real-AWS test fixture for cdkd DocDB + Neptune SDK providers',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
