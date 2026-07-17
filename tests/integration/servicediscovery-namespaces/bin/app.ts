#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ServiceDiscoveryNamespacesStack } from '../lib/servicediscovery-namespaces-stack.ts';

const app = new cdk.App();
new ServiceDiscoveryNamespacesStack(app, 'ServiceDiscoveryNamespacesStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
