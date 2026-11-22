#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV17ToV18MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV17ToV18MigrationStack(app, 'CdkdSchemaV17ToV18Migration', {
  description: 'cdkd state schema v17 -> v18 migration integ fixture (issue #6824)',
});
