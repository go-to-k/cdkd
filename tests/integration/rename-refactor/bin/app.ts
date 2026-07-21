#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RenameRefactorStack } from '../lib/rename-refactor-stack.ts';

const app = new cdk.App();
new RenameRefactorStack(app, 'CdkdRenameRefactorExample', {
  description:
    'Logical-id rename refactor: renamed resources are recreated, a kept rule is retargeted, a pinned logical id no-ops',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
