#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeStack } from '../lib/local-invoke-stack.ts';

const app = new cdk.App();

new LocalInvokeStack(app, 'CdkdLocalInvokeFixture', {
  description: 'Fixture stack for cdkd local invoke integ test',
});
