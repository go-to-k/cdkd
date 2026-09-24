#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  LocalStartServicePullRepoStack,
  LocalStartServiceStack,
} from '../lib/local-start-service-stack.ts';

const app = new cdk.App();

new LocalStartServiceStack(app, 'CdkdLocalStartServiceFixture', {
  description: 'Fixture stack for cdkd local start-service integ test',
});

new LocalStartServicePullRepoStack(app, 'CdkdLocalStartServicePullRepoFixture', {
  description: 'ECR repository the cdkd local start-service pull arms read from',
});
