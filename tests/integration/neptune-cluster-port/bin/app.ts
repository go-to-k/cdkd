#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NeptuneClusterPortStack } from '../lib/neptune-cluster-port-stack.ts';

const app = new cdk.App();
new NeptuneClusterPortStack(app, 'CdkdNeptuneClusterPortExample', {
  description: 'cdkd Neptune DBCluster in-place DBPort change integ probe (issue #7006)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
