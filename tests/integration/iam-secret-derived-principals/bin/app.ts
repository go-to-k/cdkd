#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IamSecretDerivedPrincipalsStack } from '../lib/iam-secret-derived-principals-stack.ts';

const app = new cdk.App();

new IamSecretDerivedPrincipalsStack(app, 'CdkdIamSecretDerivedPrincipals', {
  description: 'Verifies IAM principal lists named through a Secrets Manager secret against real AWS',
});
