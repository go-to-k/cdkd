#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ServiceDiscoveryHttpNamespaceUpdateStack } from '../lib/servicediscovery-http-namespace-update-stack.ts';

const app = new cdk.App();
new ServiceDiscoveryHttpNamespaceUpdateStack(app, 'CdkdServiceDiscoveryHttpNamespaceUpdate', {
  description: 'cdkd integ: a Cloud Map service in an HTTP namespace keeps deploying when its Description changes (issue 6484)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
