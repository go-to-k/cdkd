#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecreateMixedDirectionStack } from '../lib/recreate-stack.ts';

const app = new cdk.App();

new RecreateMixedDirectionStack(app, 'CdkdRecreateMixedDirection', {
  description:
    'cdkd #651 follow-up integ probe — mixed-direction recreate (SDK->CC and CC->SDK in a single deploy)',
});
