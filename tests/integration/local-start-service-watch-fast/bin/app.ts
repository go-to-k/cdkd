#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartServiceWatchFastStack } from '../lib/watch-stack.ts';

const app = new cdk.App();

new LocalStartServiceWatchFastStack(app, 'CdkdLocalStartServiceWatchFastFixture', {
  description:
    'Fixture stack for cdkd local start-service --watch bind-mount source fast path (Phase 4 of cdk-local#214; cdk-local 0.69.0)',
});
