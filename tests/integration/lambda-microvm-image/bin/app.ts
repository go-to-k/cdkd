#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaMicrovmImageStack } from '../lib/lambda-microvm-image-stack.ts';

const app = new cdk.App();

new LambdaMicrovmImageStack(app, 'CdkdMicrovmImageExample', {
  description: 'Verifies LambdaMicrovmImageProvider end-to-end against real AWS',
  env: { region: 'us-east-1' },
});
