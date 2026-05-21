#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiContainerStack } from '../lib/local-start-api-container-stack.ts';

const app = new cdk.App();

new LocalStartApiContainerStack(app, 'CdkdLocalStartApiContainerFixture', {
  description:
    'Fixture stack for cdkd local start-api integ test against a container Lambda (closes #453)',
});
