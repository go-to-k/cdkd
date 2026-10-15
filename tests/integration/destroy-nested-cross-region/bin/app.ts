#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  CdkdDestroyNestedXregionExample,
  STACK_NAME,
  STACK_REGION,
} from '../lib/destroy-nested-cross-region-stack.ts';

const app = new cdk.App();
// The region is PINNED, not taken from CDK_DEFAULT_REGION: verify.sh destroys
// the stack with the shell's region pointed elsewhere, and synth must still
// name this one.
new CdkdDestroyNestedXregionExample(app, STACK_NAME, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: STACK_REGION },
});
