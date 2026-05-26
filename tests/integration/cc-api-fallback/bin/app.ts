#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CcApiFallbackStack } from '../lib/cc-api-fallback-stack.ts';

const app = new cdk.App();

new CcApiFallbackStack(app, 'CdkdCcApiFallback', {
  description: 'cdkd Cloud Control API greenfield fallback integ probe (#614)',
});
