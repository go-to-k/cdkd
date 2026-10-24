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

// What `ListSubscriptionsByTopic` answers: the subscriptions of the bag under
// probe, each with a confirmed ARN, so a removed inline subscription resolves
// to an ARN and the update reaches `Unsubscribe`. A fake that lists nothing
// leaves the removal path at the list call (`silentPaths` sets it per bag).
let liveSubscriptions: Record<string, unknown>[] = [];

// A read delivers no property, so it is left out of the comparison: otherwise
// an update that lists subscriptions but never unsubscribes one still differs
// from one that does nothing.
const READ_COMMAND = /^(Get|List|Describe)/;

// Each client's stack is typed by its own service's inputs, so no one generic
// signature accepts all three; `never` parameters let any of them through.
interface Capturable {
  middlewareStack: { add(middleware: never, options: never): void };
}

function capturing<T extends Capturable>(client: T): T {
  const middleware =
    (_next: unknown, context: { commandName?: string }) => async (args: { request: unknown }) => {
      const command = context.commandName ?? '';
      if (command === 'ListSubscriptionsByTopicCommand') {
        return { output: { $metadata: {}, Subscriptions: liveSubscriptions }, response: {} };
      }
      if (READ_COMMAND.test(command)) return { output: fakeOutput(), response: {} };
      const req = args.request as {
        method: string;
        path: string;
        query?: Record<string, unknown>;
        headers: Record<string, string>;
        body?: unknown;
      };
      wire.push(
        JSON.stringify([
          command,
          req.method,
          req.path,
          req.query,
          req.headers['x-amz-target'],
          // The JSON protocols (SQS) hand the body over as bytes.
          typeof req.body === 'string'
            ? req.body
            : req.body instanceof Uint8Array
              ? new TextDecoder().decode(req.body)
              : JSON.stringify(req.body ?? null),
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
    return value.flatMap((v, i) => [[...prefix, i], ...paths(v, [...prefix, i])]);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [[...prefix, k], ...paths(v, [...prefix, k])]);
  }
  return [];
}

function parentOf(bag: Bag, path: Path): Record<string | number, unknown> {
  let node: Record<string | number, unknown> = bag;
  for (const seg of path.slice(0, -1)) node = node[seg] as Record<string | number, unknown>;
  return node;
}

function without(bag: Bag, path: Path): Bag {
  const copy = structuredClone(bag);
  const node = parentOf(copy, path);
  const last = path[path.length - 1]!;
  if (Array.isArray(node)) node.splice(last as number, 1);
  else delete node[last];
  return copy;
}

/**
 * The bag with the leaf at `path` changed: to `variant` when given (an enum
 * member needs a valid alternative), else to another value of its type.
 * Undefined for a non-leaf.
 */
function varied(bag: Bag, path: Path, variant?: { value: unknown }): Bag | undefined {
  const copy = structuredClone(bag);
  const node = parentOf(copy, path);
  const last = path[path.length - 1]!;
  const value = node[last];
  if (variant) node[last] = variant.value;
  else if (typeof value === 'string') node[last] = `${value}-alt`;
  else if (typeof value === 'number') node[last] = value + 1;
  else if (typeof value === 'boolean') node[last] = !value;
  else return undefined;
  return copy;
}

type Outcome = { threw: false; wire: string } | { threw: true; message: string };

async function record(run: () => Promise<unknown>): Promise<Outcome> {
  wire.length = 0;
  try {
    await run();
  } catch (error) {
    return { threw: true, message: (error as Error).message };
  }
  return { threw: false, wire: wire.join('\n') };
}

interface Case {
  resourceType: string;
  provider: () => ResourceProvider;
  physicalId: string;
  /** Top-levels the engine replaces on instead of updating; skipped on update. */
  createOnly: ReadonlySet<string>;
  bag: Bag;
  /** Path label -> the value a removal-throwing leaf is varied to. */
  variants?: Record<string, unknown>;
}

interface Result {
  /** Probes whose removal (or variation) left the write sequence unchanged. */
  silent: string[];
  /** Probes where the reduced side THREW: removal cannot observe delivery there. */
  removalThrows: string[];
}

/**
 * Removing any one path must change what reaches the wire; if it does not, the
 * member is dropped. Probed on create, and on update in both directions, with
 * ONE argument varying per comparison: an `update()` that re-sends every desired
 * attribute would otherwise mask a change on the side under test.
 *
 * - `create`: `create(full)` vs `create(full - P)`
 * - `update-add`: `update(next=full, prev=full-P)` vs `update(next=full-P, prev=full-P)`
 *   (only `next` varies)
 * - `update-remove`: `update(next=full-P, prev=full)` vs `update(next=full-P, prev=full-P)`
 *   (only `prev` varies, so the removal-reset path is what is observed)
 *
 * A reduced side that THROWS is not delivery: it lands in `removalThrows`, and
 * that path is probed instead by changing its value, in each direction that
 * threw: on create, `create(full)` vs `create(alt)`; on update,
 * `update(next=full, prev=base)` vs `update(next=alt, prev=base)`, where `base`
 * lacks the leaf's parent so both sides make the same call and only the value
 * differs.
 */
/** The fake list answers with `bag`'s subscriptions, the i-th as `<topic>:sub-<i>`. */
function armLiveSubscriptions(physicalId: string, bag: Bag): void {
  const subs = Array.isArray(bag['Subscription']) ? (bag['Subscription'] as Bag[]) : [];
  liveSubscriptions = subs.map((s, i) => ({
    Protocol: s['Protocol'],
    Endpoint: s['Endpoint'],
    SubscriptionArn: `${physicalId}:sub-${i}`,
    TopicArn: physicalId,
  }));
}

async function probe(c: Case): Promise<Result> {
  const p = c.provider();
  const create = (bag: Bag) => () => p.create('L', c.resourceType, structuredClone(bag));
  const update = (next: Bag, prev: Bag) => () =>
    p.update('L', c.physicalId, c.resourceType, structuredClone(next), structuredClone(prev));

  armLiveSubscriptions(c.physicalId, c.bag);

  const full = await record(create(c.bag));
  const settled = await record(update(c.bag, c.bag));
  // Every create comparison is made against `full`, so a throwing `full` would
  // make them vacuous; `settled` guards that a no-op update succeeds at all.
  expect(full).toMatchObject({ threw: false });
  expect(settled).toMatchObject({ threw: false });
  const fullWire = (full as { wire: string }).wire;

  const silent: string[] = [];
  const removalThrows: string[] = [];
  const compare = (direction: string, label: string, a: Outcome, b: Outcome): boolean => {
    if (a.threw || b.threw) {
      removalThrows.push(`${direction}:${label}`);
      return true;
    }
    if (a.wire === b.wire) silent.push(`${direction}:${label}`);
    return false;
  };

  for (const path of paths(c.bag)) {
    const label = path.join('.');
    const reduced = without(c.bag, path);
    const createThrew = compare('create', label, await record(create(reduced)), full);
    let updateThrew = false;
    if (!c.createOnly.has(String(path[0]))) {
      updateThrew =
        compare(
          'update-add',
          label,
          await record(update(c.bag, reduced)),
          await record(update(reduced, reduced))
        ) || updateThrew;
      updateThrew =
        compare(
          'update-remove',
          label,
          await record(update(reduced, c.bag)),
          await record(update(reduced, reduced))
        ) || updateThrew;
    }
    if (!createThrew && !updateThrew) continue;
    const alt = varied(
      c.bag,
      path,
      c.variants && label in c.variants ? { value: c.variants[label] } : undefined
    );
    if (createThrew) {
      const altOutcome = alt === undefined ? undefined : await record(create(alt));
      if (altOutcome === undefined || altOutcome.threw || altOutcome.wire === fullWire) {
        silent.push(`create-vary:${label}`);
      }
    }
    if (updateThrew) {
      const base = without(c.bag, path.length > 1 ? path.slice(0, -1) : path);
      const before = await record(update(c.bag, base));
      const after = alt === undefined ? undefined : await record(update(alt, base));
      if (before.threw || after === undefined || after.threw || after.wire === before.wire) {
        silent.push(`update-vary:${label}`);
      }
    }
  }
  return { silent, removalThrows };
}

interface BagCase {
  name: string;
  bag: Bag;
  variants?: Record<string, unknown>;
  /** Probe label -> why it is silent. Exact: a fixed gap must leave the list. */
  expectedSilent?: Record<string, string>;
  /** Probe label -> why removing that path throws. Exact, like `expectedSilent`. */
  expectedRemovalThrows?: Record<string, string>;
}

interface TypeCase {
  resourceType: string;
  provider: () => ResourceProvider;
  physicalId: string;
  createOnly: ReadonlySet<string>;
  /** `handledProperties` entries no bag carries, each with the reason. */
  exempt: Record<string, string>;
  /**
   * Removal probes that only see THAT the wire changed, not WHICH member it
   * names: removing one element of a two-element list from `bags[0]` must send
   * `command` exactly once, naming `names` and not `notNames`.
   */
  targets: { path: Path; command: string; names: string; notNames: string }[];
  bags: BagCase[];
}

const ROLE = `arn:aws:iam::${ACCOUNT}:role/r`;
const QUEUE_ARN = (name: string) => `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`;

const TAGS_REFUSED =
  'a Tags entry without its Key or Value is refused before any call (go-to-k/cdkd#3994)';
const SUBSCRIPTION_REFUSED =
  'an inline Subscription without a string Protocol and Endpoint is refused before Subscribe';

// Not a gap: CloudFormation keeps the live value when these are removed
// (measured A/B, go-to-k/cdkd#5004), so update() deliberately sends nothing.
const CFN_KEEPS_ON_REMOVAL =
  'CloudFormation keeps the live value on removal (go-to-k/cdkd#5004); deliberately absent from SQS_ATTRIBUTE_REMOVAL_RESET';
// Not a gap: SetQueueAttributes re-sends the whole policy from `next` and never
// reads `prev`, so a member removed from a still-declared policy is delivered
// by `next` alone (the update-add probe of the same path observes that).
const WHOLE_POLICY_FROM_NEXT =
  'update() re-sends the whole policy from next; prev is not read for a declared policy';

const TAG_THROWS = (directions: string[], count: number): Record<string, string> =>
  Object.fromEntries(
    directions.flatMap((d) =>
      Array.from({ length: count }, (_, i) => [
        [`${d}:Tags.${i}.Key`, TAGS_REFUSED],
        [`${d}:Tags.${i}.Value`, TAGS_REFUSED],
      ]).flat()
    )
  );

const CASES: TypeCase[] = [
  {
    resourceType: 'AWS::SNS::Topic',
    provider: () => new SNSTopicProvider(),
    physicalId: `arn:aws:sns:us-east-1:${ACCOUNT}:t.fifo`,
    createOnly: new Set(['FifoTopic', 'TopicName']),
    exempt: {},
    targets: [
      { path: ['Subscription', 0], command: 'UnsubscribeCommand', names: 'sub-0', notNames: 'sub-1' },
      { path: ['Subscription', 1], command: 'UnsubscribeCommand', names: 'sub-1', notNames: 'sub-0' },
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
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
          Subscription: [
            { Protocol: 'sqs', Endpoint: QUEUE_ARN('q1') },
            { Protocol: 'sqs', Endpoint: QUEUE_ARN('q2') },
          ],
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        variants: { 'DeliveryStatusLogging.0.Protocol': 'sqs' },
        expectedRemovalThrows: {
          ...TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
          'create:DeliveryStatusLogging.0.Protocol':
            'create() refuses a DeliveryStatusLogging entry without a supported Protocol (update() warns and skips it)',
          ...Object.fromEntries(
            [0, 1].flatMap((i) =>
              ['create', 'update-remove'].flatMap((d) => [
                [`${d}:Subscription.${i}.Protocol`, SUBSCRIPTION_REFUSED],
                [`${d}:Subscription.${i}.Endpoint`, SUBSCRIPTION_REFUSED],
              ])
            )
          ),
        },
      },
      {
        // A value-dependent drop is invisible to a bag of truthy values only.
        name: 'falsy values',
        bag: {
          TopicName: 'f.fifo',
          FifoTopic: true,
          ContentBasedDeduplication: false,
          DisplayName: '',
        },
        expectedSilent: {
          'create:ContentBasedDeduplication':
            'CreateTopic gates on truthiness; false is the service default, so omitting it is equivalent',
          'create:DisplayName':
            'CreateTopic gates on truthiness; an empty display name is the service default',
        },
      },
    ],
  },
  {
    resourceType: 'AWS::SQS::Queue',
    provider: () => new SQSQueueProvider(),
    physicalId: `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/q.fifo`,
    createOnly: new Set(['FifoQueue', 'QueueName']),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagQueueCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagQueueCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'KMS encryption',
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
            deadLetterTargetArn: QUEUE_ARN('dlq.fifo'),
            maxReceiveCount: 5,
          },
          RedriveAllowPolicy: { redrivePermission: 'allowAll' },
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        expectedSilent: {
          'update-remove:DeduplicationScope': CFN_KEEPS_ON_REMOVAL,
          'update-remove:FifoThroughputLimit': CFN_KEEPS_ON_REMOVAL,
          'update-remove:RedrivePolicy.deadLetterTargetArn': WHOLE_POLICY_FROM_NEXT,
          'update-remove:RedrivePolicy.maxReceiveCount': WHOLE_POLICY_FROM_NEXT,
          'update-remove:RedriveAllowPolicy.redrivePermission': WHOLE_POLICY_FROM_NEXT,
        },
        expectedRemovalThrows: TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
      },
      {
        // `SqsManagedSseEnabled` is mutually exclusive with `KmsMasterKeyId`.
        name: 'SQS-managed encryption',
        bag: { QueueName: 'q', SqsManagedSseEnabled: true },
        expectedSilent: { 'update-remove:SqsManagedSseEnabled': CFN_KEEPS_ON_REMOVAL },
      },
      {
        name: 'falsy values',
        bag: {
          QueueName: 'q',
          ContentBasedDeduplication: false,
          DelaySeconds: 0,
          ReceiveMessageWaitTimeSeconds: 0,
        },
      },
    ],
  },
];

describe('SDK wire coverage', () => {
  describe.each(CASES)('$resourceType', (t) => {
    it('its bags carry every handledProperties entry not exempted', () => {
      const handled = [...(t.provider().handledProperties?.get(t.resourceType) ?? [])].sort();
      expect(handled.length).toBeGreaterThan(0);
      const carried = new Set(t.bags.flatMap((b) => Object.keys(b.bag)));
      for (const key of carried) expect(handled).toContain(key);
      for (const key of Object.keys(t.exempt)) expect(carried.has(key)).toBe(false);
      expect([...carried, ...Object.keys(t.exempt)].sort()).toEqual(handled);
    });

    it.each(t.bags)('delivers every path of the $name bag', async (b) => {
      const { silent, removalThrows } = await probe({ ...t, bag: b.bag, variants: b.variants });
      expect(silent.sort()).toEqual(Object.keys(b.expectedSilent ?? {}).sort());
      expect(removalThrows.sort()).toEqual(Object.keys(b.expectedRemovalThrows ?? {}).sort());
    });

    it.each(t.targets)('removing $path sends $command naming only $names', async (target) => {
      const full = t.bags[0]!.bag;
      armLiveSubscriptions(t.physicalId, full);
      const outcome = await record(() =>
        t
          .provider()
          .update('L', t.physicalId, t.resourceType, without(full, target.path), structuredClone(full))
      );
      expect(outcome).toMatchObject({ threw: false });
      const bodies = (outcome as { wire: string }).wire
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
        .filter((entry) => entry[0] === target.command)
        .map((entry) => entry[entry.length - 1]!);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain(target.names);
      expect(bodies[0]).not.toContain(target.notNames);
    });
  });
});
