#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaMigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaMigrationStack(app, 'CdkdSchemaV5ToV6Migration', {
  description: 'cdkd state schema v5 -> v6 migration integ probe',
});
