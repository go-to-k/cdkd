#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BasicStack } from '../lib/basic-stack';

const app = new cdk.App();

new BasicStack(app, 'CdkdBasicExample', {
  description: 'Basic cdkd example with S3 bucket',
});
