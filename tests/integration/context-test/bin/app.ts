#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ContextTestStack } from '../lib/context-test-stack';

const app = new cdk.App();
new ContextTestStack(app, 'ContextTestStack', {
  description: 'cdkd context test - cdk.json and CLI context',
});
