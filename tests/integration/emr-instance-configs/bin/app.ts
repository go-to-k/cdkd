#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EmrInstanceConfigsStack } from '../lib/emr-instance-configs-stack.ts';

const app = new cdk.App();
new EmrInstanceConfigsStack(app, 'CdkdEmrInstanceConfigsExample', {
  description:
    'cdkd integ: AWS::EMR::InstanceGroupConfig SDK provider (standalone TASK group on a single-node cluster)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
