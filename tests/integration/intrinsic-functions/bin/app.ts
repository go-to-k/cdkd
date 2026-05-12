#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IntrinsicFunctionsStack } from '../lib/intrinsic-functions-stack.ts';

const app = new cdk.App();

new IntrinsicFunctionsStack(app, 'CdkdIntrinsicFunctionsExample', {
  description: 'cdkd example demonstrating CloudFormation intrinsic function resolution',
});
