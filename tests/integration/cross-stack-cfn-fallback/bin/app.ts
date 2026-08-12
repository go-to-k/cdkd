#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CfnFallbackConsumerStack } from '../lib/cfn-fallback-consumer-stack.ts';

const app = new cdk.App();

new CfnFallbackConsumerStack(app, 'CdkdCfnFallbackConsumer', {
  description:
    'cdkd #1697 integ consumer: references a CloudFormation-managed producer via the CFn fallback',
});
