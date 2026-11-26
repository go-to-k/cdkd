#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConsumerStack, ProducerStack } from '../lib/stacks.ts';

const app = new cdk.App();
const env = { region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1' };
// CDKD_TEST_UPDATE=true renames the producer's queue (a replacement, so its
// exported URL and ARN change). CDKD_TEST_FAIL=true adds a consumer resource
// AWS refuses, created after the consumer's function moved onto the new queue.
const updated = process.env.CDKD_TEST_UPDATE === 'true';
const fail = process.env.CDKD_TEST_FAIL === 'true';

const producer = new ProducerStack(app, 'CdkdXsReplaceRbProd', { env, updated });
new ConsumerStack(app, 'CdkdXsReplaceRbCons', { env, queue: producer.queue, fail });
