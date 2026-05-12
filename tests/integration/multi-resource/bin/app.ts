#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MultiResourceStack } from '../lib/multi-resource-stack.ts';

const app = new cdk.App();

new MultiResourceStack(app, 'CdkdMultiResourceExample', {
  description: 'Multi-resource example with complex dependencies for cdkd',
});
