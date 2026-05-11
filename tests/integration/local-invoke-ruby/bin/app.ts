#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeRubyStack } from '../lib/local-invoke-ruby-stack';

const app = new cdk.App();

new LocalInvokeRubyStack(app, 'CdkdLocalInvokeRubyFixture', {
  description: 'Fixture stack for cdkd local invoke Ruby integ test',
});
