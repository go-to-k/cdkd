#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartWebFunctionStack } from '../lib/local-start-web-function-stack.ts';

const app = new cdk.App();

new LocalStartWebFunctionStack(app, 'CdkdLocalStartWebFunctionFixture', {
  description: 'Fixture stack for cdkd local start-web-function integ test',
});
