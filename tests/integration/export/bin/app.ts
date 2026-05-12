#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ExportStack } from '../lib/export-stack.ts';

const app = new cdk.App();

new ExportStack(app, 'CdkdExportExample', {
  description:
    'Real-AWS integ test for `cdkd export` (cdkd → CloudFormation IMPORT changeset).',
});
