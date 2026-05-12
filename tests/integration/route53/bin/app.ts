#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Route53Stack } from '../lib/route53-stack.ts';

const app = new cdk.App();
new Route53Stack(app, 'Route53Stack', {
  description: 'cdkd Route53 example with HostedZone and RecordSet',
});
