#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AlbStack } from '../lib/alb-stack';

const app = new cdk.App();

new AlbStack(app, 'AlbStack', {
  description: 'cdkd ALB example with LoadBalancer, TargetGroup, Listener',
});
