#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeJavaStack } from '../lib/local-invoke-java-stack.ts';

const app = new cdk.App();

new LocalInvokeJavaStack(app, 'CdkdLocalInvokeJavaFixture', {
  description: 'Fixture stack for cdkd local invoke Java integ test',
});
