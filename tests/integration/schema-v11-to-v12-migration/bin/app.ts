#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV11ToV12MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV11ToV12MigrationStack(app, 'CdkdSchemaV11ToV12Migration', {
  description: 'cdkd state schema v11 -> v12 migration integ fixture (issues #4847 / #4852)',
});
