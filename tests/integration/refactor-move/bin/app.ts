#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DestStack, SourceStack } from '../lib/refactor-move-stacks.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
const moved = process.env.CDKD_TEST_UPDATE === 'true';
const dest = new DestStack(app, 'CdkdRefactorMoveDest', { env, moved });
new SourceStack(app, 'CdkdRefactorMoveSource', { env, moved, dest });
