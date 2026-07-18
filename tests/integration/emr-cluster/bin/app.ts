#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EmrClusterStack } from '../lib/emr-cluster-stack.ts';

const app = new cdk.App();
new EmrClusterStack(app, 'CdkdEmrClusterExample', {
  description: 'cdkd integ: AWS::EMR::Cluster SDK provider (single-node EMR on EC2)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
