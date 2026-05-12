#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BenchCcapiStack } from '../lib/bench-ccapi-stack.ts';

const app = new cdk.App();

new BenchCcapiStack(app, 'CdkdBenchCcapi', {
  description: 'cdkd benchmark stack: Cloud Control API only',
});
