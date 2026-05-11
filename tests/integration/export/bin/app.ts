#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ExportStack } from '../lib/export-stack';

const app = new cdk.App();

new ExportStack(app, 'CdkdExportExample', {
  description:
    'Real-AWS integ test for `cdkd export` (cdkd → CloudFormation IMPORT changeset).',
});
