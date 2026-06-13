#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DeploymentEventsStack } from '../lib/deployment-events-stack.ts';

const app = new cdk.App();

new DeploymentEventsStack(app, 'CdkdDeploymentEventsExample', {
  description: 'Exercises cdkd structured deployment events to S3 + the `cdkd events` command (issue #808)',
});
