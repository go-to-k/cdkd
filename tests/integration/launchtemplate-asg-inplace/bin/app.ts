#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LaunchTemplateAsgInplaceStack } from '../lib/launchtemplate-asg-inplace-stack.ts';

const app = new cdk.App();

new LaunchTemplateAsgInplaceStack(app, 'LaunchTemplateAsgInplaceStack', {
  description:
    'LaunchTemplate + AutoScalingGroup in-place GetAtt (LatestVersionNumber) propagation for cdkd (issue #985)',
});
