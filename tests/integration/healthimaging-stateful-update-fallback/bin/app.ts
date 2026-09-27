#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HealthImagingStatefulUpdateFallbackStack } from '../lib/healthimaging-stateful-update-fallback-stack.ts';

const app = new cdk.App();
new HealthImagingStatefulUpdateFallbackStack(app, 'CdkdHealthImagingStatefulUpdateFallbackExample', {
  description: 'cdkd stateful guard on the update-failure (Cloud Control UnsupportedAction) fallback integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
