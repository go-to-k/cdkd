#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AlbAdvancedStack } from '../lib/alb-advanced-stack.ts';

const app = new cdk.App();

new AlbAdvancedStack(app, 'AlbAdvancedStack', {
  description: 'cdkd ALB advanced example with ListenerRule, multiple TargetGroups, path-based routing',
});
