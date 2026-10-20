#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GeneratedNameLifecycleStack } from '../lib/generated-name-lifecycle-stack.ts';

const app = new cdk.App();

// Short: an ELBv2 name is capped at 32 characters, and the stack name is the
// prefix of every generated name.
new GeneratedNameLifecycleStack(app, 'CdkdGenNameLife', {
  description: 'Generated physical names across a stack lifetime (issue #5064)',
});
