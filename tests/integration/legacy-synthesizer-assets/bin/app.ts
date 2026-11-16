#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LegacySynthesizerAssetsStack } from '../lib/legacy-synthesizer-assets-stack.ts';

const app = new cdk.App();
new LegacySynthesizerAssetsStack(app, 'CdkdLegacySynthesizerAssetsExample', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  // The subject: no `<Stack>.assets.json`; assets travel as `aws:cdk:asset`
  // metadata plus `AssetParameters…` template parameters (issue #6421).
  synthesizer: new cdk.LegacyStackSynthesizer(),
});
