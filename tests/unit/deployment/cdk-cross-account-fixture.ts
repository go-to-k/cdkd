import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { AssemblyReader, type StackInfo } from '../../../src/synthesis/assembly-reader.js';

/** The two fake accounts every case synthesizes with. */
export const PRODUCER_ACCOUNT = '111111111111';
export const CONSUMER_ACCOUNT = '222222222222';
/** The second consumer's account, for the `two-consumers` app. */
export const SECOND_CONSUMER_ACCOUNT = '333333333333';

export type FixtureKind =
  /** aws-cdk-lib's generated cross-account reference, default feature flags. */
  | 'generated'
  /** The same, with `@aws-cdk/core:enablePartitionLiterals` on (a literal `RoleArn`). */
  | 'generated-partition-literals'
  /** A user-written `Fn.getStackOutput` whose role ARN is built by `formatArn`. */
  | 'user-format-arn'
  /** `generated`, plus a second consumer `ConsumerB` in another account (one shared producer role). */
  | 'two-consumers';

export interface SynthesizedApp {
  readonly stacks: StackInfo[];
  readonly producer: StackInfo;
  readonly consumer: StackInfo;
  /** The consumer's `Fn::GetStackOutput` argument, exactly as synthesized. */
  readonly reference: Record<string, unknown>;
}

function findGetStackOutput(node: unknown): Record<string, unknown> | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findGetStackOutput(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const arg = record['Fn::GetStackOutput'];
  if (arg !== null && typeof arg === 'object' && !Array.isArray(arg)) {
    return arg as Record<string, unknown>;
  }
  for (const value of Object.values(record)) {
    const found = findGetStackOutput(value);
    if (found) return found;
  }
  return undefined;
}

/**
 * Synthesize a two-account app with aws-cdk-lib and read it back through
 * cdkd's own `AssemblyReader`, so every case asserts the REAL generated shapes.
 */
export function synthesizeCrossAccountApp(
  kind: FixtureKind,
  region = 'us-east-1'
): SynthesizedApp {
  const outdir = mkdtempSync(join(tmpdir(), 'cdkd-xacc-'));
  try {
    const app = new cdk.App({
      outdir,
      context:
        kind === 'generated-partition-literals'
          ? { '@aws-cdk/core:enablePartitionLiterals': true }
          : {},
    });
    const producer = new cdk.Stack(app, 'Producer', {
      env: { account: PRODUCER_ACCOUNT, region },
    });
    const topic = new cdk.CfnResource(producer, 'Topic', { type: 'AWS::SNS::Topic' });
    const consumer = new cdk.Stack(app, 'Consumer', {
      env: { account: CONSUMER_ACCOUNT, region },
    });
    if (kind === 'user-format-arn') {
      new cdk.CfnResource(producer, 'ReaderRole', {
        type: 'AWS::IAM::Role',
        properties: {
          RoleName: 'cdkd-state-reader',
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: `arn:aws:iam::${CONSUMER_ACCOUNT}:root` },
                Action: 'sts:AssumeRole',
              },
            ],
          },
        },
      });
      new cdk.CfnOutput(producer, 'TopicArn', { value: topic.ref });
      const roleArn = consumer.formatArn({
        service: 'iam',
        region: '',
        account: PRODUCER_ACCOUNT,
        resource: 'role',
        resourceName: 'cdkd-state-reader',
      });
      new cdk.CfnResource(consumer, 'Queue', {
        type: 'AWS::SQS::Queue',
        properties: {
          QueueName: cdk.Fn.getStackOutput('Producer', 'TopicArn', region, roleArn),
        },
      });
    } else {
      new cdk.CfnResource(consumer, 'Queue', {
        type: 'AWS::SQS::Queue',
        properties: { QueueName: topic.ref },
      });
      if (kind === 'two-consumers') {
        const second = new cdk.Stack(app, 'ConsumerB', {
          env: { account: SECOND_CONSUMER_ACCOUNT, region },
        });
        new cdk.CfnResource(second, 'Queue', {
          type: 'AWS::SQS::Queue',
          properties: { QueueName: topic.ref },
        });
      }
    }
    app.synth();
    const reader = new AssemblyReader();
    const stacks = reader.getAllStacks(outdir, reader.readManifest(outdir));
    const producerInfo = stacks.find((s) => s.stackName === 'Producer');
    const consumerInfo = stacks.find((s) => s.stackName === 'Consumer');
    if (!producerInfo || !consumerInfo) throw new Error('fixture: stacks not synthesized');
    const reference = findGetStackOutput(consumerInfo.template);
    if (!reference) throw new Error('fixture: no Fn::GetStackOutput in the consumer');
    return { stacks, producer: producerInfo, consumer: consumerInfo, reference };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}
