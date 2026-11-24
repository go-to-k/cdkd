#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DeployForceQuitRollbackStack } from '../lib/deploy-force-quit-rollback-stack.ts';

const app = new cdk.App();
new DeployForceQuitRollbackStack(app, 'CdkdDeployForceQuitRollback', {
  description:
    'Integ fixture for a force-quit / closed-terminal deploy (#6894): the rollback journal written on the second SIGINT or a SIGHUP lets cdkd rollback revert the resources already updated.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
