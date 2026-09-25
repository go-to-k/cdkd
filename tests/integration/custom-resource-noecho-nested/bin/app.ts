#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ImportConsumerStack, ImportProducerStack } from '../lib/import-stacks.ts';
import { NestedParentStack } from '../lib/nested-parent-stack.ts';
import { ParamParentStack } from '../lib/param-stack.ts';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new NestedParentStack(app, 'CdkdCrNoEchoNestedExample', {
  description:
    'cdkd integ (issue 2460) - a NoEcho custom resource value crossing a nested-stack boundary',
  env,
});

new ParamParentStack(app, 'CdkdCrNoEchoParamExample', {
  description:
    'cdkd integ (issues 3717, 3722) - a NoEcho value through a nested stack parameter, and a custom resource whose physical id moves',
  env,
});

const producer = new ImportProducerStack(app, 'CdkdCrNoEchoProducerExample', {
  description: 'cdkd integ (issue 2460) - exports a NoEcho custom resource value',
  env,
});
const consumer = new ImportConsumerStack(app, 'CdkdCrNoEchoConsumerExample', {
  description: 'cdkd integ (issue 2460) - imports a NoEcho custom resource value',
  env,
});

// `cdk.Fn.importValue` is a synth-time token that propagates NO stack
// dependency, so without this edge `deploy --all` could race the consumer's
// import against a producer whose state has not been written yet — and, for
// this fixture specifically, against a recovery store the producer has not
// filled yet.
consumer.addDependency(producer);
