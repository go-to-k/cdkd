#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CodeBuildWebhookStack } from '../lib/codebuild-webhook-stack.ts';

const app = new cdk.App();

new CodeBuildWebhookStack(app, 'CdkdCodeBuildWebhookExample', {
  description: 'Verifies CodeBuildProvider Triggers through the webhook calls (issue #5627)',
  env: { region: 'us-east-1' },
});
