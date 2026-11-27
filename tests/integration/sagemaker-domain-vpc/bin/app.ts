#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SageMakerDomainVpcStack } from '../lib/sagemaker-domain-vpc-stack.ts';

const app = new cdk.App();
new SageMakerDomainVpcStack(app, 'CdkdSageMakerDomainVpcExample', {
  description: 'cdkd SageMaker domain VpcId replacement refusal integ (go-to-k/cdkd#7126)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
