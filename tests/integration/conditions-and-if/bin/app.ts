#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConditionsAndIfStack } from '../lib/conditions-and-if-stack.ts';

const app = new cdk.App();

new ConditionsAndIfStack(app, 'CdkdConditionsIfExample', {
  description: 'CloudFormation Conditions + Fn::If stress test for cdkd',
});
