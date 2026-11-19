#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecreateRenamedLogsDeliveryStack } from '../lib/recreate-renamed-logs-delivery-stack.ts';

const app = new cdk.App();
new RecreateRenamedLogsDeliveryStack(app, 'CdkdRecreateRenamedLogsDelivery', {
  description:
    'cdkd --recreate-via-cc-api order integ for a renamed CloudWatch Logs delivery source and destination (issue 6589)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
