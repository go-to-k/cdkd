#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { IntrinsicFunctionsStack } from '../lib/intrinsic-functions-stack';

const app = new cdk.App();

new IntrinsicFunctionsStack(app, 'CdkqIntrinsicFunctionsExample', {
  description: 'cdkq example demonstrating CloudFormation intrinsic function resolution',
});
