#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeProvidedStack } from '../lib/local-invoke-provided-stack.ts';

const app = new cdk.App();

new LocalInvokeProvidedStack(app, 'CdkdLocalInvokeProvidedFixture', {
  description: 'Fixture stack for cdkd local invoke provided.* + go1.x integ test',
});
