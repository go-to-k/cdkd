#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokePythonStack } from '../lib/local-invoke-python-stack';

const app = new cdk.App();

new LocalInvokePythonStack(app, 'CdkdLocalInvokePythonFixture', {
  description: 'Fixture stack for cdkd local invoke Python integ test',
});
