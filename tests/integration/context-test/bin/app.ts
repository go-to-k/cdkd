#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ContextTestStack } from '../lib/context-test-stack.ts';

const app = new cdk.App();
new ContextTestStack(app, 'ContextTestStack', {
  description: 'cdkd context test - cdk.json and CLI context',
});
