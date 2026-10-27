#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CdkdNlbQuicServerIdStack } from '../lib/nlb-quic-server-id-stack.ts';

const app = new cdk.App();

new CdkdNlbQuicServerIdStack(app, 'CdkdNlbQuicServerIdExample', {
  description: 'cdkd NLB QUIC target group Targets[].QuicServerId (issue #5394)',
  // A concrete env: an env-agnostic stack resolves availabilityZones to dummy AZs.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
