#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  SchemaMigrationProducerStack,
  SchemaMigrationConsumerStack,
} from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaMigrationProducerStack(app, 'CdkdSchemaV7ToV8MigrationProducer', {
  description: 'cdkd state schema v7 -> v8 migration integ producer',
});

new SchemaMigrationConsumerStack(app, 'CdkdSchemaV7ToV8MigrationConsumer', {
  description: 'cdkd state schema v7 -> v8 migration integ consumer (Fn::GetStackOutput)',
});
