#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeFromCfnStackStack } from '../lib/local-invoke-from-cfn-stack-stack.ts';

const app = new cdk.App();

new LocalInvokeFromCfnStackStack(app, 'CdkdLocalInvokeFromCfnStackFixture', {
  description: 'Fixture stack for cdkd local invoke --from-cfn-stack integ test',
});
