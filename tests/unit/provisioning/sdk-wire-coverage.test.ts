import { describe, it, expect, vi } from 'vite-plus/test';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import { STSClient } from '@aws-sdk/client-sts';

// Real clients, so the SDK's schema-driven serializer runs and drops any member
// it does not know. The build-step middleware captures the serialized request
// and answers without calling `next`, which skips signing, the network and
// deserialization alike.
const wire: string[] = [];

const ACCOUNT = '123456789012';
const fakeOutput = (): unknown =>
  new Proxy(
    { $metadata: {} },
    {
      get(target, key) {
        if (typeof key !== 'string') return undefined;
        if (key in target) return (target as Record<string, unknown>)[key];
        if (key === 'Attributes') return fakeOutput();
        if (key === 'Account') return ACCOUNT;
        if (key.endsWith('Arn')) return `arn:aws:svc:us-east-1:${ACCOUNT}:fake`;
        if (key.endsWith('Url')) return `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/fake`;
        return undefined;
      },
    }
  );

// Each client's stack is typed by its own service's inputs, so no one generic
// signature accepts all three; `never` parameters let any of them through.
interface Capturable {
  middlewareStack: { add(middleware: never, options: never): void };
}

function capturing<T extends Capturable>(client: T): T {
  const middleware = () => async (args: { request: unknown }) => {
    const req = args.request as {
      method: string;
      path: string;
      query?: Record<string, unknown>;
      headers: Record<string, string>;
      body?: unknown;
    };
    wire.push(
      JSON.stringify([
        req.method,
        req.path,
        req.query,
        req.headers['x-amz-target'],
        typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null),
      ])
    );
    return { output: fakeOutput(), response: {} };
  };
  const options = { step: 'build', name: 'wireCapture', priority: 'low' };
  client.middlewareStack.add(middleware as never, options as never);
  return client;
}

const clientOptions = {
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIDFAKE', secretAccessKey: 'fake' },
};
const clients = {
  sns: capturing(new SNSClient(clientOptions)),
  sqs: capturing(new SQSClient(clientOptions)),
  sts: capturing(new STSClient(clientOptions)),
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

type Bag = Record<string, unknown>;
type Path = (string | number)[];

/** Every key path in the bag, so nested members are probed individually. */
function paths(value: unknown, prefix: Path = []): Path[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => paths(v, [...prefix, i]));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [[...prefix, k], ...paths(v, [...prefix, k])]);
  }
  return [];
}

function without(bag: Bag, path: Path): Bag {
  const copy = structuredClone(bag);
  let node: Record<string | number, unknown> = copy;
  for (const seg of path.slice(0, -1)) node = node[seg] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (Array.isArray(node)) node.splice(last as number, 1);
  else delete node[last];
  return copy;
}

async function record(run: () => Promise<unknown>): Promise<string> {
  wire.length = 0;
  try {
    await run();
  } catch (error) {
    return `THROW ${(error as Error).message}`;
  }
  return wire.join('\n');
}

interface Case {
  resourceType: string;
  provider: () => ResourceProvider;
  physicalId: string;
  bag: Bag;
}

/**
 * Removing any one path must change what reaches the wire; if it does not, the
 * member is dropped. Probed on create, and on update in both directions.
 * Create-only top-levels are excluded from update: the engine replaces instead.
 */
async function silentPaths(c: Case, createOnly: ReadonlySet<string>): Promise<string[]> {
  const p = c.provider();
  const create = (bag: Bag) => () => p.create('L', c.resourceType, structuredClone(bag));
  const update = (next: Bag, prev: Bag) => () =>
    p.update('L', c.physicalId, c.resourceType, structuredClone(next), structuredClone(prev));

  // Only ONE argument varies per comparison: an update() that always re-sends
  // the full attribute set would otherwise look identical to a no-op.
  const full = await record(create(c.bag));
  const settled = await record(update(c.bag, c.bag));
  const silent: string[] = [];
  for (const path of paths(c.bag)) {
    const label = path.join('.');
    const reduced = without(c.bag, path);
    if ((await record(create(reduced))) === full) silent.push(`create:${label}`);
    if (createOnly.has(String(path[0]))) continue;
    if ((await record(update(c.bag, reduced))) === (await record(update(reduced, reduced)))) {
      silent.push(`update-add:${label}`);
    }
    if ((await record(update(reduced, c.bag))) === settled) silent.push(`update-remove:${label}`);
  }
  return silent;
}

const ROLE = `arn:aws:iam::${ACCOUNT}:role/r`;

describe('SDK wire coverage (PoC)', () => {
  it('AWS::SNS::Topic delivers every declared path', async () => {
    const silent = await silentPaths(
      {
        resourceType: 'AWS::SNS::Topic',
        provider: () => new SNSTopicProvider(),
        physicalId: `arn:aws:sns:us-east-1:${ACCOUNT}:t.fifo`,
        bag: {
          TopicName: 't.fifo',
          FifoTopic: true,
          ContentBasedDeduplication: true,
          DisplayName: 'd',
          KmsMasterKeyId: 'alias/k',
          TracingConfig: 'Active',
          SignatureVersion: '2',
          FifoThroughputScope: 'Topic',
          MaximumMessageSize: 2048,
          ArchivePolicy: { MessageRetentionPeriod: 7 },
          DataProtectionPolicy: { Name: 'p', Version: '2021-06-01', Statement: [] },
          DeliveryStatusLogging: [
            {
              Protocol: 'lambda',
              SuccessFeedbackRoleArn: ROLE,
              FailureFeedbackRoleArn: ROLE,
              SuccessFeedbackSampleRate: '50',
            },
          ],
          Subscription: [{ Protocol: 'sqs', Endpoint: `arn:aws:sqs:us-east-1:${ACCOUNT}:q` }],
          Tags: [{ Key: 'k', Value: 'v' }],
        },
      },
      new Set(['FifoTopic', 'TopicName'])
    );
    expect(silent).toEqual([]);
  });

  it('AWS::SQS::Queue delivers every declared path', async () => {
    const silent = await silentPaths(
      {
        resourceType: 'AWS::SQS::Queue',
        provider: () => new SQSQueueProvider(),
        physicalId: `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/q.fifo`,
        bag: {
          QueueName: 'q.fifo',
          FifoQueue: true,
          ContentBasedDeduplication: true,
          DeduplicationScope: 'messageGroup',
          FifoThroughputLimit: 'perMessageGroupId',
          VisibilityTimeout: 31,
          MaximumMessageSize: 2048,
          MessageRetentionPeriod: 3600,
          DelaySeconds: 3,
          ReceiveMessageWaitTimeSeconds: 4,
          KmsMasterKeyId: 'alias/k',
          KmsDataKeyReusePeriodSeconds: 600,
          RedrivePolicy: {
            deadLetterTargetArn: `arn:aws:sqs:us-east-1:${ACCOUNT}:dlq.fifo`,
            maxReceiveCount: 5,
          },
          RedriveAllowPolicy: { redrivePermission: 'allowAll' },
          Tags: [{ Key: 'k', Value: 'v' }],
        },
      },
      new Set(['FifoQueue', 'QueueName'])
    );
    expect(silent).toEqual([]);
  });
});
