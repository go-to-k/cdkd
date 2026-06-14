#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DeepGetAttChainsStack } from '../lib/deep-getatt-chains-stack.ts';

const app = new cdk.App();

new DeepGetAttChainsStack(app, 'CdkdDeepGetAttChainsExample', {
  description:
    'cdkd failure-seeking example: a 5-deep GetAtt chain where each resource POST-CREATE attribute feeds the next (SDK + CC-API mix)',
});
