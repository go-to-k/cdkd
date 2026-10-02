#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DynamoDBGlobalTableImpliedStreamStack } from '../lib/dynamodb-globaltable-implied-stream-stack.ts';

const app = new cdk.App();
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
new DynamoDBGlobalTableImpliedStreamStack(app, 'CdkdDynamoDBGlobalTableImpliedStreamExample', {
  description:
    'cdkd GlobalTable records the stream it auto-enables for two replicas and no StreamSpecification (issue #1723)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  // verify.sh passes the replica region it probes; the default is the same
  // rule verify.sh applies, so a bare synth still yields two DISTINCT regions.
  secondRegion:
    process.env.CDKD_INTEG_SECOND_REGION ?? (region === 'us-west-2' ? 'us-east-1' : 'us-west-2'),
});
