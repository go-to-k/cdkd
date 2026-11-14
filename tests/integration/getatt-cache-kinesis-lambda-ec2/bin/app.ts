#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattCacheKinesisLambdaEc2Stack } from '../lib/getatt-cache-kinesis-lambda-ec2-stack.ts';

const app = new cdk.App();
new GetattCacheKinesisLambdaEc2Stack(app, 'CdkdGetattCacheKinesisLambdaEc2Example', {
  description:
    'cdkd Fn::GetAtt ElastiCache RedisEndpoint / ConfigurationEndpoint, Kinesis WarmThroughputObject, Lambda SnapStartResponse and EC2 Instance State integ probe (issue #6242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
