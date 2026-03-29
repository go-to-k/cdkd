#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ExporterStack } from '../lib/exporter-stack';
import { ConsumerStack } from '../lib/consumer-stack';

const app = new cdk.App();

// Create the exporter stack first (must be deployed before consumer)
new ExporterStack(app, 'CdkdExporterStack', {
  description: 'Stack that exports values for cross-stack references',
});

// Create the consumer stack that imports values from the exporter
new ConsumerStack(app, 'CdkdConsumerStack', {
  description: 'Stack that consumes exported values via Fn::ImportValue',
});
