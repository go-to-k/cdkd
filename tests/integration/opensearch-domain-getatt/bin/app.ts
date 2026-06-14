#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OpenSearchDomainStack } from '../lib/opensearch-domain-stack.ts';

const app = new cdk.App();
new OpenSearchDomainStack(app, 'CdkdOpenSearchDomainExample', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
});
