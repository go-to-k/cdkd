#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LegacyBucketFallbackStack } from '../lib/legacy-bucket-fallback-stack';

const app = new cdk.App();

new LegacyBucketFallbackStack(app, 'CdkdLegacyBucketFallback', {
  description: 'Tiny stack used by the legacy-bucket-name-fallback integ test',
});
