#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  DriftCcReadOnlyPropsConsumerStack,
  DriftCcReadOnlyPropsStack,
} from '../lib/drift-cc-read-only-props-stack.ts';

const app = new cdk.App();
new DriftCcReadOnlyPropsStack(app, 'CdkdDriftCcReadOnlyPropsExample', {
  description: "cdkd drift on a Cloud Control resource's read-only properties integ probe",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
new DriftCcReadOnlyPropsConsumerStack(app, 'CdkdDriftCcReadOnlyPropsConsumer', {
  description: "imports the drift-cc-read-only-props Tracker's UpdateTime (go-to-k/cdkd#7007)",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
