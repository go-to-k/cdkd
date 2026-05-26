#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack } from '../lib/producer-stack.ts';
import { ConsumerStack } from '../lib/consumer-stack.ts';

const app = new cdk.App();

// The shared CloudFormation export name. Producer emits an Output with
// `Export.Name` set to this; consumer's Lambda env var pulls it via
// `Fn::ImportValue`. The literal is intentionally distinctive so the
// integ can grep for it.
const EXPORT_NAME = 'cdkd-multi-stack-shared-value';

const producer = new ProducerStack(app, 'CdkdLocalInvokeMultiStackProducer', {
  description: 'Producer stack: emits an SSM Parameter and exports its name via Fn::ImportValue.',
  exportName: EXPORT_NAME,
});

new ConsumerStack(app, 'CdkdLocalInvokeMultiStackConsumer', {
  description: 'Consumer stack: Lambda env reads producer export via Fn::ImportValue.',
  exportName: EXPORT_NAME,
}).addDependency(producer);
