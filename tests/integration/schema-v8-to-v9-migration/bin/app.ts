#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  SchemaMigrationProducerStack,
  SchemaMigrationDecoyStack,
  SchemaMigrationConsumerStack,
} from '../lib/schema-migration-stack.ts';

const app = new cdk.App();

new SchemaMigrationProducerStack(app, 'CdkdSchemaV8ToV9MigrationProducer', {
  description: 'cdkd state schema v8 -> v9 migration integ producer (exports SHARED_NAME)',
});

new SchemaMigrationDecoyStack(app, 'CdkdSchemaV8ToV9MigrationDecoy', {
  description: 'cdkd state schema v8 -> v9 migration integ decoy (plain output named SHARED_NAME)',
});

new SchemaMigrationConsumerStack(app, 'CdkdSchemaV8ToV9MigrationConsumer', {
  description: 'cdkd state schema v8 -> v9 migration integ consumer (Fn::ImportValue SHARED_NAME)',
});
