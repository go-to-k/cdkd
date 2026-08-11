#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CodeBuildProjectStack } from '../lib/codebuild-project-stack.ts';

const app = new cdk.App();

new CodeBuildProjectStack(app, 'CdkdCodeBuildProjectExample', {
  description:
    'Verifies CodeBuildProvider BuildBatchConfig removal reset + the seven CFn-retained fields (issue #1160)',
  env: { region: 'us-east-1' },
});
