#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BenchSdkStack } from '../lib/bench-sdk-stack.ts';

const app = new cdk.App();

new BenchSdkStack(app, 'CdkdBenchSdk', {
  description: 'cdkd benchmark stack: SDK Provider only',
});
