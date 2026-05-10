#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiStack } from '../lib/local-start-api-stack';

const app = new cdk.App();

new LocalStartApiStack(app, 'CdkdLocalStartApiFixture', {
  description: 'Fixture stack for cdkd local start-api integ test',
});
