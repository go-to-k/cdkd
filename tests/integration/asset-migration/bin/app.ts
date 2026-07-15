#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AssetMigrationStack, AssetMigrationImageStack } from '../lib/asset-migration-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
new AssetMigrationStack(app, 'CdkdAssetMigrationStack', { env });
// Separate stack so verify.sh can deploy the Docker leg only when a Docker
// daemon is available on the runner.
new AssetMigrationImageStack(app, 'CdkdAssetMigrationImageStack', { env });
