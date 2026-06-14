#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SdkCcApiCrossrefStack } from '../lib/sdk-ccapi-crossref-stack.ts';

const app = new cdk.App();

new SdkCcApiCrossrefStack(app, 'CdkdSdkCcApiCrossrefExample', {
  description:
    'cdkd SDK-provider <-> Cloud Control API cross-reference boundary integ (#614 routing mix)',
});
