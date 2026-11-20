#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Route53DriftImportStack } from '../lib/route53-drift-import-stack.ts';

const app = new cdk.App();
new Route53DriftImportStack(app, 'Route53DriftImportStack', {
  description: 'cdkd Route 53 drift (deleted records, mode revert) and auto import',
});
