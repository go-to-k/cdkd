#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  NestedHostedRotationStack,
  NestedSamTransformStack,
} from '../lib/nested-stack-transform-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
new NestedSamTransformStack(app, 'CdkdIntegNestedTransform', {
  description: 'cdkd nested-stack Transform expansion integ (SAM child)',
  env,
});
new NestedHostedRotationStack(app, 'CdkdIntegNestedTransformRot', {
  description: 'cdkd nested-stack Transform expansion integ (HostedRotation child)',
  env,
});
