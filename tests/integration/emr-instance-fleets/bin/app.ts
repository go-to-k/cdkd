#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EmrInstanceFleetsStack } from '../lib/emr-instance-fleets-stack.ts';

const app = new cdk.App();
new EmrInstanceFleetsStack(app, 'CdkdEmrInstanceFleetsExample', {
  description:
    'cdkd integ: AWS::EMR::InstanceFleetConfig SDK provider + inline instance fleets (per-instance-type Configurations)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
