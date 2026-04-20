#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BenchCcapiStack } from '../lib/bench-ccapi-stack';

const app = new cdk.App();

new BenchCcapiStack(app, 'CdkdBenchCcapi', {
  description: 'cdkd benchmark stack: Cloud Control API only',
});
