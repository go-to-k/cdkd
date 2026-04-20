#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BenchSdkStack } from '../lib/bench-sdk-stack';

const app = new cdk.App();

new BenchSdkStack(app, 'CdkdBenchSdk', {
  description: 'cdkd benchmark stack: SDK Provider only',
});
