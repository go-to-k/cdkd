#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamManagedPolicyOutsidePrincipalStack } from '../lib/iam-managed-policy-outside-principal-stack.ts';

const app = new cdk.App();

new IamManagedPolicyOutsidePrincipalStack(app, 'CdkdIamManagedPolicyOutsidePrincipalExample', {
  description: 'A managed policy attached outside the stack is not detached by its delete (#7117)',
});
