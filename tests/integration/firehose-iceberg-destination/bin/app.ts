#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FirehoseIcebergDestinationStack } from '../lib/firehose-iceberg-destination-stack.ts';

const app = new cdk.App();
new FirehoseIcebergDestinationStack(app, 'CdkdFirehoseIcebergDestinationExample', {
  description: 'cdkd Firehose IcebergDestinationConfiguration SDK-route integ probe',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
