#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LakeFormationRoleSwitchStack } from '../lib/lakeformation-role-switch-stack.ts';

const app = new cdk.App();

new LakeFormationRoleSwitchStack(app, 'CdkdLakeFormationRoleSwitchExample', {
  description: 'A Lake Formation location switching off the service-linked role updates in place (#7121)',
});
