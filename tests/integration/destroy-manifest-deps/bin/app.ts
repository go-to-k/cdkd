#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ParamStack } from '../lib/destroy-manifest-deps-stack.ts';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

// Pair 1 (go-to-k/cdkd#6115): a crossRegionReferences strong reference. The
// consumer (us-east-1) reads the producer's (us-west-2) parameter ARN; the
// only edge the cloud assembly records is a manifest dependency.
const xrProducer = new ParamStack(app, 'CdkdDmdXrProducer', {
  description: 'cdkd destroy-manifest-deps: cross-region producer (us-west-2)',
  env: { account, region: 'us-west-2' },
  crossRegionReferences: true,
  paramName: 'xr-producer',
});
new ParamStack(app, 'CdkdDmdXrConsumer', {
  description: 'cdkd destroy-manifest-deps: cross-region consumer (us-east-1)',
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  paramName: 'xr-consumer',
  reads: xrProducer.param,
});

// Pair 2: an explicit addDependency with no reference at all, so destroying
// the producer alone under -e leaves a consumer that still works.
const depProducer = new ParamStack(app, 'CdkdDmdDepProducer', {
  description: 'cdkd destroy-manifest-deps: addDependency producer (us-east-1)',
  env: { account, region: 'us-east-1' },
  paramName: 'dep-producer',
});
const depConsumer = new ParamStack(app, 'CdkdDmdDepConsumer', {
  description: 'cdkd destroy-manifest-deps: addDependency consumer (us-east-1)',
  env: { account, region: 'us-east-1' },
  paramName: 'dep-consumer',
});
depConsumer.addDependency(depProducer);
