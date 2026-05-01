#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StateInfoStack } from '../lib/state-info-stack';

const app = new cdk.App();

new StateInfoStack(app, 'CdkdStateInfoExample', {
  description: 'Minimal stack for cdkd state info integration test',
});
