#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaEsmSelfManagedKafkaStack } from '../lib/lambda-esm-self-managed-kafka-stack.ts';

const app = new cdk.App();
new LambdaEsmSelfManagedKafkaStack(app, 'CdkdLambdaEsmSelfManagedKafkaExample', {
  description: 'cdkd Lambda self-managed Kafka ESM Endpoints key integ probe',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
