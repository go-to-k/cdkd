#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MultiResourceStack } from '../lib/multi-resource-stack';

const app = new cdk.App();

new MultiResourceStack(app, 'CdkqMultiResourceExample', {
  description: 'Multi-resource example with complex dependencies for cdkq',
});
