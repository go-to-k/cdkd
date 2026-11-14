#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattIamWafS3vectorsEvaluatorStack } from '../lib/getatt-iam-waf-s3vectors-evaluator-stack.ts';

const app = new cdk.App();
new GetattIamWafS3vectorsEvaluatorStack(app, 'CdkdGetattIamWafS3vectorsEvaluator', {
  description:
    'cdkd Fn::GetAtt ManagedPolicy / WebACL / VectorBucket / Evaluator read-only attributes integ probe (issue #6242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
