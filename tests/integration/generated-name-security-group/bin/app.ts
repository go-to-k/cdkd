#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GeneratedNameSecurityGroupStack } from '../lib/generated-name-security-group-stack.ts';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };
new GeneratedNameSecurityGroupStack(app, 'CdkdGeneratedNameSgExample', {
  description: 'cdkd integ: generated security group name (issue 5095)',
  env,
});
// The peer joins the first stack's VPC, so it exists only once verify.sh has
// read that VPC's id from state.
const sharedVpcId = process.env.GNSG_SHARED_VPC_ID;
if (sharedVpcId !== undefined && sharedVpcId !== '') {
  new GeneratedNameSecurityGroupStack(app, 'CdkdGeneratedNameSgPeerExample', {
    description: 'cdkd integ: generated security group name, second stack in the same VPC (issue 5095)',
    env,
    sharedVpcId,
  });
}
