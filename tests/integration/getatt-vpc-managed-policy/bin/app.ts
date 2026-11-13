#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattVpcManagedPolicyStack } from '../lib/getatt-vpc-managed-policy-stack.ts';

const app = new cdk.App();
new GetattVpcManagedPolicyStack(app, 'CdkdGetattVpcManagedPolicyExample', {
  description:
    'cdkd Fn::GetAtt VPC DefaultNetworkAcl / CidrBlockAssociations and ManagedPolicy PolicyId / DefaultVersionId integ probe (issue #6232)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
