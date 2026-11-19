#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackRegeneratedSecretStack } from '../lib/rollback-regenerated-secret-stack.ts';

const app = new cdk.App();

new RollbackRegeneratedSecretStack(app, 'CdkdRollbackRegeneratedSecret', {
  description:
    'A rollback that regenerates a secret restores its readers with the regenerated value (go-to-k/cdkd#6591)',
});
