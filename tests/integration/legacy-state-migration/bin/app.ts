#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LegacyMigrationStack } from '../lib/legacy-migration-stack.ts';

const app = new cdk.App();

new LegacyMigrationStack(app, 'CdkdLegacyMigrationExample', {
  description:
    'Single-resource fixture stack used by tests/integration/legacy-state-migration to ' +
    'verify auto-migration of a pre-PR-1 state.json into the region-prefixed key layout.',
});
