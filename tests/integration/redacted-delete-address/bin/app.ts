#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RedactedDeleteAddressStack } from '../lib/redacted-delete-address-stack.ts';

const app = new cdk.App();
new RedactedDeleteAddressStack(app, 'CdkdRedactedDeleteAddressExample', {
  description: 'cdkd delete of a resource whose recorded address property is redacted (issue #3952)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
