#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TagsPropagationStack } from '../lib/tags-propagation-stack.ts';

const app = new cdk.App();

const stack = new TagsPropagationStack(app, 'CdkdTagsPropagationExample', {
  description:
    'Failure-seeking real-AWS integ for STACK-LEVEL tag propagation across many taggable types on both the SDK-provider and Cloud Control API paths',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});

// STACK-LEVEL tags applied at the App scope so they propagate to EVERY
// taggable resource in the stack via the CFn `Tags` property. verify.sh
// asserts each of these lands on every resource type (both paths). The
// exact key/value strings are duplicated in verify.sh — keep them in sync.
cdk.Tags.of(app).add('CdkdTagOwner', 'cdkd-integ');
cdk.Tags.of(app).add('CdkdTagEnv', 'test');
cdk.Tags.of(app).add('CdkdTagCostCenter', 'cc-1234');

// Reference the stack so the lint/TS "unused" rule stays quiet while the
// tags above attach at the App scope.
void stack;
