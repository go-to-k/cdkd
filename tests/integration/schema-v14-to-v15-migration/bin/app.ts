#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV14ToV15MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV14ToV15MigrationStack(app, 'CdkdSchemaV14ToV15Migration', {
  description: 'cdkd state schema v14 -> v15 migration integ fixture (issue #5498)',
});
