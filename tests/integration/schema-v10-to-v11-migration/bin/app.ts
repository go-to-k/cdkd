#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV10ToV11MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV10ToV11MigrationStack(app, 'CdkdSchemaV10ToV11Migration', {
  description: 'cdkd state schema v10 -> v11 migration integ fixture (issues #4043 / #2449)',
});
