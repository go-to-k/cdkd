#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConditionsStack } from '../lib/conditions-stack.ts';

const app = new cdk.App();

new ConditionsStack(app, 'CdkdConditionsExample', {
  description: 'CloudFormation Conditions example with cdkd',
});
