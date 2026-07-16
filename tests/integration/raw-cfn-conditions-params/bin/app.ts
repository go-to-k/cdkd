#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RawCfnStack } from '../lib/raw-cfn-stack.ts';

const app = new cdk.App();

new RawCfnStack(app, 'CdkdRawCfnCondParamsExample', {
  description: 'Raw CFn template via CfnInclude - Parameters/Conditions diff parity (issues #1027/#1028)',
});
