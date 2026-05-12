#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BasicStack } from '../lib/basic-stack.ts';

const app = new cdk.App();

new BasicStack(app, 'CdkdBasicExample', {
  description: 'Basic cdkd example with S3 bucket',
});
