#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SubnetMapPublicIpRemovalStack } from '../lib/subnet-mappublicip-removal-stack.ts';

const app = new cdk.App();
new SubnetMapPublicIpRemovalStack(app, 'CdkdSubnetMapPublicIpRemovalExample', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
