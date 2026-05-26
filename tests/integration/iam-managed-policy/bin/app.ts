#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamManagedPolicyStack } from '../lib/iam-managed-policy-stack.ts';

const app = new cdk.App();

new IamManagedPolicyStack(app, 'CdkdIamManagedPolicyExample', {
  description: 'Verifies IAMManagedPolicyProvider end-to-end against real AWS',
});
