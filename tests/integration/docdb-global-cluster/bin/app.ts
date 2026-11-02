#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DocdbGlobalClusterStack } from '../lib/docdb-global-cluster-stack.ts';

const app = new cdk.App();
new DocdbGlobalClusterStack(app, 'CdkdDocdbGlobalClusterExample', {
  description: 'cdkd DocDB cluster joining a global cluster (GlobalClusterIdentifier) integ',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
