#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AlbStack } from '../lib/alb-stack.ts';

const app = new cdk.App();

new AlbStack(app, 'AlbStack', {
  description: 'cdkd ALB example with LoadBalancer, TargetGroup, Listener',
});
