#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ConditionsStack } from '../lib/conditions-stack';

const app = new cdk.App();

new ConditionsStack(app, 'CdkdConditionsExample', {
  description: 'CloudFormation Conditions example with cdkd',
});
