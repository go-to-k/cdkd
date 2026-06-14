#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConditionsUpdate2Stack } from '../lib/conditions-update-2-stack.ts';

const app = new cdk.App();

new ConditionsUpdate2Stack(app, 'CdkdConditionsUpdate2Example', {
  description: 'Harder CloudFormation Conditions-on-UPDATE semantics stress test for cdkd',
});
