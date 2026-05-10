#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeFromStateStack } from '../lib/local-invoke-from-state-stack';

const app = new cdk.App();

new LocalInvokeFromStateStack(app, 'CdkdLocalInvokeFromStateFixture', {
  description: 'Fixture stack for cdkd local invoke --from-state integ test',
});
