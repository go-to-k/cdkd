#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DemoStack } from '../lib/demo-stack.ts';

const app = new cdk.App();

new DemoStack(app, 'CdkdDemoCdk', { description: 'Demo stack deployed via cdk (CloudFormation)' });
new DemoStack(app, 'CdkdDemoCdkd', { description: 'Demo stack deployed via cdkd (direct SDK)' });
