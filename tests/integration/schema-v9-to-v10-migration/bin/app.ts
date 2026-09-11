#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV9ToV10MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV9ToV10MigrationStack(app, 'CdkdSchemaV9ToV10Migration', {
  description: 'cdkd state schema v9 -> v10 migration integ fixture (issue #2944)',
});
