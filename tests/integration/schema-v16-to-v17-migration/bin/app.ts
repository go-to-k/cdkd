#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV16ToV17MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV16ToV17MigrationStack(app, 'CdkdSchemaV16ToV17Migration', {
  description: 'cdkd state schema v16 -> v17 migration integ fixture (issue #6146)',
});
