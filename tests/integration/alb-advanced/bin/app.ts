#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AlbAdvancedStack } from '../lib/alb-advanced-stack';

const app = new cdk.App();

new AlbAdvancedStack(app, 'AlbAdvancedStack', {
  description: 'cdkd ALB advanced example with ListenerRule, multiple TargetGroups, path-based routing',
});
