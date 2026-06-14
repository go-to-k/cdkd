#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RedshiftClusterStack } from '../lib/redshift-cluster-stack.ts';

const app = new cdk.App();
new RedshiftClusterStack(app, 'CdkdRedshiftClusterExample', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
});
