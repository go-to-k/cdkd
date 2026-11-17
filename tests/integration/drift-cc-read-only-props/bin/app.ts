#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DriftCcReadOnlyPropsStack } from '../lib/drift-cc-read-only-props-stack.ts';

const app = new cdk.App();
new DriftCcReadOnlyPropsStack(app, 'CdkdDriftCcReadOnlyPropsExample', {
  description: "cdkd drift on a Cloud Control resource's read-only properties integ probe",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
