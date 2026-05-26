#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaMigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaMigrationStack(app, 'CdkdSchemaV6ToV7Migration', {
  description: 'cdkd state schema v6 -> v7 migration integ probe',
});
