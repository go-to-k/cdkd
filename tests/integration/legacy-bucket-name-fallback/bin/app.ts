#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LegacyBucketFallbackStack } from '../lib/legacy-bucket-fallback-stack.ts';

const app = new cdk.App();

new LegacyBucketFallbackStack(app, 'CdkdLegacyBucketFallback', {
  description: 'Tiny stack used by the legacy-bucket-name-fallback integ test',
});
