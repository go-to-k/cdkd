#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MigrateSmallStack } from '../lib/migrate-small-stack';
import { MigrateLargeStack } from '../lib/migrate-large-stack';

const app = new cdk.App();

// Two stacks, two paths through retireCloudFormationStack:
//   - Small stack: synthesized template fits the inline 51,200-byte
//     UpdateStack TemplateBody limit. Exercises the original retire flow.
//   - Large stack: synthesized template is >51,200 bytes (one Lambda with
//     padded inline code). Exercises the cdkd-state-bucket TemplateURL
//     upload path added in PR #113.
new MigrateSmallStack(app, 'CdkdMigrateSmall', {
  description: 'cdkd integ: --migrate-from-cloudformation small (inline TemplateBody) path',
});

new MigrateLargeStack(app, 'CdkdMigrateLarge', {
  description: 'cdkd integ: --migrate-from-cloudformation large (>51,200B TemplateURL) path',
});
