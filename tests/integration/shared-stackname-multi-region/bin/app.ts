#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProducerStack, ConsumerStack } from '../lib/shared-stackname-multi-region-stack.ts';

const app = new cdk.App();

// Both regions come from `verify.sh`; the defaults keep a bare synth working.
const regionA = process.env['CDKD_IT_5176_REGION_A'] ?? 'us-east-1';
const regionB = process.env['CDKD_IT_5176_REGION_B'] ?? 'us-west-2';

// One Stage per region, each holding the SAME two stackNames (issue #5176):
// a multi-region app deployed as one Stage per region. The AWS CDK CLI deploys
// all four; the consumer reads the producer through a CDK cross-stack
// reference, which synthesizes an `Fn::ImportValue` whose export name is
// derived from the producer's stackName, so both regions publish the SAME
// export name.
for (const [stageId, region] of [
  ['RegionA', regionA],
  ['RegionB', regionB],
] as const) {
  const stage = new cdk.Stage(app, stageId, { env: { region } });
  const producer = new ProducerStack(stage, 'Producer', {
    stackName: 'CdkdSharedName5176',
    description: 'cdkd issue #5176: producer, one per region under a shared stackName',
  });
  new ConsumerStack(stage, 'Consumer', {
    stackName: 'CdkdSharedConsumer5176',
    description: 'cdkd issue #5176: consumer, one per region under a shared stackName',
    producerParameterName: producer.parameter.parameterName,
  });
}
