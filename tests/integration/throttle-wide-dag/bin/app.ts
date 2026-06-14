#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ThrottleWideDagStack } from '../lib/throttle-wide-dag-stack.ts';

const app = new cdk.App();

new ThrottleWideDagStack(app, 'CdkdThrottleWideDagExample', {
  description:
    'Wide (~100-resource) stack stressing the concurrency limiter + throttle/retry classifier + event-driven DAG executor (SSM Parameters + IAM Roles + SNS Topics; subset chained for DAG depth)',
});
