#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SchemaV12ToV13MigrationStack } from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaV12ToV13MigrationStack(app, 'CdkdSchemaV12ToV13Migration', {
  description: 'cdkd state schema v12 -> v13 migration integ fixture (issue #5064)',
});
