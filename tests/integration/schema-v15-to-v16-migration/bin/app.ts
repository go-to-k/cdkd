#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV15ToV16MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV15ToV16MigrationStack(app, 'CdkdSchemaV15ToV16Migration', {
  description: 'cdkd state schema v15 -> v16 migration integ fixture (issue #6170)',
});
