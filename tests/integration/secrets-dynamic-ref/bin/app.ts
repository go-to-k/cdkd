#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SecretsDynamicRefStack } from '../lib/secrets-dynamic-ref-stack.ts';

const app = new cdk.App();

new SecretsDynamicRefStack(app, 'CdkdSecretsDynamicRefExample', {
  description:
    'cdkd failure-seeking fixture for CloudFormation dynamic references ({{resolve:secretsmanager}} / {{resolve:ssm}})',
});
