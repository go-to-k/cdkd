#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PipesInputTemplateRemovalStack } from '../lib/pipes-input-template-removal-stack.ts';

const app = new cdk.App();

new PipesInputTemplateRemovalStack(app, 'PipesInputTemplateRemovalStack', {
  description: 'cdkd Pipe InputTemplate removal (issue #6233)',
});
