#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeLayersStack } from '../lib/local-invoke-layers-stack';

const app = new cdk.App();

new LocalInvokeLayersStack(app, 'CdkdLocalInvokeLayersFixture', {
  description: 'Fixture stack for cdkd local invoke Lambda Layers integ test',
});
