#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StateDestroyStack } from '../lib/state-destroy-stack';

const app = new cdk.App();

new StateDestroyStack(app, 'CdkdStateDestroyExample', {
  description: 'Integration test for cdkd state destroy command',
});
