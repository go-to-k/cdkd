#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();

// Stack 1: Network resources (VPC + Security Group)
const networkStack = new NetworkStack(app, 'CdkqNetworkStack', {
  description: 'Network stack with VPC and Security Group (exports VPC ID)',
});

// Stack 2: Data resources (DynamoDB + S3) - depends on NetworkStack for ordering
const dataStack = new DataStack(app, 'CdkqDataStack', {
  description: 'Data stack with DynamoDB table and S3 bucket (exports table/bucket names)',
});
dataStack.addDependency(networkStack);

// Stack 3: Application resources (Lambda + IAM) - imports from DataStack
new AppStack(app, 'CdkqAppStack', {
  description: 'App stack with Lambda that imports DataStack values via Fn::ImportValue',
});
