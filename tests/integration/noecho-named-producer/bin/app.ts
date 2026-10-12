#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  NoEchoNamedConsumerStack,
  NoEchoNamedProducerStack,
} from '../lib/noecho-named-producer-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const producer = new NoEchoNamedProducerStack(app, 'CdkdNoEchoNamedProducerExample', {
  description: 'cdkd: an SNS topic named from a NoEcho parameter, read by ARN (go-to-k/cdkd#4849)',
  env,
});

const consumer = new NoEchoNamedConsumerStack(app, 'CdkdNoEchoNamedProducerConsumer', {
  description: "cdkd: imports the NoEcho-named topic's exported ARN (go-to-k/cdkd#4849)",
  env,
});
// `Fn.importValue` is a synth-time token and carries no stack dependency.
consumer.addDependency(producer);
