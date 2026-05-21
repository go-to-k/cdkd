#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeBuildkitStack } from '../lib/local-invoke-buildkit-stack.ts';

const app = new cdk.App();

new LocalInvokeBuildkitStack(app, 'CdkdLocalInvokeBuildkitFixture', {
  description: 'Fixture stack for cdkd local invoke against a BuildKit-only Dockerfile',
});
