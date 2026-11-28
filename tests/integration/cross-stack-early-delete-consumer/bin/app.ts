#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ConsumerStack, ProducerStack } from '../lib/stacks.ts';

const app = new cdk.App();
const env = { region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1' };
// CDKD_TEST_UPDATE=true renames the producer's function (replacing it and its
// alias, and removing its old version). CDKD_TEST_FAIL=true adds a consumer
// resource AWS refuses, created after the consumer's function moved onto the
// new alias.
const updated = process.env.CDKD_TEST_UPDATE === 'true';
const fail = process.env.CDKD_TEST_FAIL === 'true';

const producer = new ProducerStack(app, 'CdkdXsEarlyDelProd', { env, updated });
new ConsumerStack(app, 'CdkdXsEarlyDelCons', { env, alias: producer.alias, fail });
