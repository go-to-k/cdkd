import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#4606 / #4655, the S3 slice: a failed CREATE's proven orphan
// bucket is deleted by a later successful deploy only when (a) the record
// under its logical id holds ANOTHER bucket (`isSameResource`), and (b) the
// bucket under the journaled name is still the generation that CREATE made
// (`resourceIdentity`: name + region + this account's ListBuckets
// CreationDate). Every doubt answers 'unknown' / undefined, which keeps the
// bucket.

const { mockSend, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  ...(await import('../s3-create-client-forward.js')).forwardedS3Client(),
}));

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { NoSuchBucket } from '@aws-sdk/client-s3';
import { S3BucketProvider } from '../../../../src/provisioning/providers/s3-bucket-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';

const TYPE = 'AWS::S3::Bucket';
const ORPHAN = 'stack-orphan-bucket-a';
const RECORD = 'stack-orphan-bucket-b';
const CREATED = new Date('2026-10-09T01:02:03.000Z');
const CTX = { expectedRegion: 'us-east-1' };

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const noSuchBucket = (): Error =>
  new NoSuchBucket({ message: 'The specified bucket does not exist', $metadata: { httpStatusCode: 404 } });
const denied = (): Error =>
  Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });

/** Buckets by name: where each lives, and what this account's list says of it. */
function world(buckets: Record<string, { region?: string; listed?: Date | 'unlisted' } | Error>): void {
  mockSend.mockImplementation((cmd: Cmd) => {
    const name = cmd.constructor.name;
    const bucket = cmd.input['Bucket'] as string | undefined;
    if (name === 'GetBucketLocationCommand') {
      const b = buckets[bucket ?? ''];
      if (b === undefined) return Promise.reject(noSuchBucket());
      if (b instanceof Error) return Promise.reject(b);
      const region = b.region ?? 'us-east-1';
      return Promise.resolve({ LocationConstraint: region === 'us-east-1' ? null : region });
    }
    if (name === 'ListBucketsCommand') {
      const prefix = (cmd.input['Prefix'] as string | undefined) ?? '';
      return Promise.resolve({
        Buckets: Object.entries(buckets)
          .filter(([n, b]) => n.startsWith(prefix) && !(b instanceof Error) && b.listed !== 'unlisted')
          .map(([Name, b]) => ({ Name, CreationDate: (b as { listed?: Date }).listed ?? CREATED })),
      });
    }
    return Promise.resolve({});
  });
}

const sent = (): string[] => mockSend.mock.calls.map((c) => (c[0] as Cmd).constructor.name);

describe('S3BucketProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  let provider: S3BucketProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new S3BucketProvider();
  });

  it("is 'different' for two names once the record's bucket reads back in the region", async () => {
    world({ [ORPHAN]: {}, [RECORD]: {} });

    await expect(provider.isSameResource(ORPHAN, { physicalId: RECORD }, TYPE, CTX)).resolves.toBe(
      'different'
    );
    // The record's bucket is what must be read; the orphan needs no read.
    const located = mockSend.mock.calls
      .map((c) => c[0] as Cmd)
      .filter((c) => c.constructor.name === 'GetBucketLocationCommand')
      .map((c) => c.input['Bucket']);
    expect(located).toEqual([RECORD]);
  });

  it("is 'same' for one name, with no read", async () => {
    world({});

    await expect(provider.isSameResource(ORPHAN, { physicalId: ORPHAN }, TYPE, CTX)).resolves.toBe(
      'same'
    );
    expect(sent()).toEqual([]);
  });

  it.each([
    ["the record's bucket is gone", { [ORPHAN]: {} }],
    ["the record's bucket is in another region", { [ORPHAN]: {}, [RECORD]: { region: 'us-west-2' } }],
    ["the record's bucket cannot be located", { [ORPHAN]: {}, [RECORD]: denied() }],
  ] as const)("is 'unknown' when %s", async (_label, buckets) => {
    world(buckets as Parameters<typeof world>[0]);

    await expect(provider.isSameResource(ORPHAN, { physicalId: RECORD }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
  });

  it("is 'unknown' from a client in another region than the stack's", async () => {
    clientRegion.value = 'us-west-2';
    world({ [ORPHAN]: {}, [RECORD]: {} });

    await expect(provider.isSameResource(ORPHAN, { physicalId: RECORD }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    expect(sent()).toEqual([]);
  });

  it.each([
    ['an ARN', 'arn:aws:s3:::stack-orphan-bucket-a'],
    ['a legacy mixed-case name', 'Stack_Orphan'],
    ['an empty string', ''],
  ])("is 'unknown' for %s on either side, with no read", async (_label, odd) => {
    world({});

    await expect(provider.isSameResource(odd, { physicalId: RECORD }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    await expect(provider.isSameResource(ORPHAN, { physicalId: odd }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    expect(sent()).toEqual([]);
  });

  it("is 'unknown' for another type", async () => {
    await expect(
      provider.isSameResource(ORPHAN, { physicalId: RECORD }, 'AWS::S3::BucketPolicy', CTX)
    ).resolves.toBe('unknown');
  });
});

describe('S3BucketProvider.resourceIdentity (go-to-k/cdkd#4606)', () => {
  let provider: S3BucketProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new S3BucketProvider();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the bucket generation by name, region and this account\'s CreationDate', async () => {
    world({ [ORPHAN]: {} });

    await expect(provider.resourceIdentity(ORPHAN, TYPE, CTX)).resolves.toBe(
      `${ORPHAN}|us-east-1|2026-10-09T01:02:03.000Z`
    );
    const list = mockSend.mock.calls
      .map((c) => c[0] as Cmd)
      .find((c) => c.constructor.name === 'ListBucketsCommand');
    expect(list?.input['Prefix']).toBe(ORPHAN);
  });

  it('gives a re-created bucket (a later CreationDate) another token', async () => {
    world({ [ORPHAN]: {} });
    const first = await provider.resourceIdentity(ORPHAN, TYPE, CTX);
    world({ [ORPHAN]: { listed: new Date('2026-10-09T02:00:00.000Z') } });

    await expect(provider.resourceIdentity(ORPHAN, TYPE, CTX)).resolves.not.toBe(first);
  });

  it('matches the exact name only, never a longer one the prefix also lists', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    world({ [ORPHAN]: { listed: 'unlisted' }, [`${ORPHAN}-other`]: {} });

    const pending = provider.resourceIdentity(ORPHAN, TYPE, CTX);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBeUndefined();
  });

  it('answers RESOURCE_NOT_FOUND only on NoSuchBucket', async () => {
    world({});

    await expect(provider.resourceIdentity(ORPHAN, TYPE, CTX)).resolves.toBe(RESOURCE_NOT_FOUND);
    expect(sent()).toEqual(['GetBucketLocationCommand']);
  });

  it('re-reads a list that has not caught up yet, then names it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let lists = 0;
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'GetBucketLocationCommand') {
        return Promise.resolve({ LocationConstraint: null });
      }
      lists++;
      return Promise.resolve({
        Buckets: lists < 2 ? [] : [{ Name: ORPHAN, CreationDate: CREATED }],
      });
    });

    const pending = provider.resourceIdentity(ORPHAN, TYPE, CTX);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(`${ORPHAN}|us-east-1|2026-10-09T01:02:03.000Z`);
    expect(lists).toBe(2);
  });

  it.each([
    ['a bucket this account does not list (another account\'s)', { [ORPHAN]: { listed: 'unlisted' } }],
    ['a bucket in another region', { [ORPHAN]: { region: 'us-west-2' } }],
    ['a location that cannot be read', { [ORPHAN]: denied() }],
  ] as const)('is undefined for %s', async (_label, buckets) => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    world(buckets as Parameters<typeof world>[0]);

    const pending = provider.resourceIdentity(ORPHAN, TYPE, CTX);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBeUndefined();
  });

  it('is undefined when the list itself cannot be read', async () => {
    mockSend.mockImplementation((cmd: Cmd) =>
      cmd.constructor.name === 'GetBucketLocationCommand'
        ? Promise.resolve({ LocationConstraint: null })
        : Promise.reject(denied())
    );

    await expect(provider.resourceIdentity(ORPHAN, TYPE, CTX)).resolves.toBeUndefined();
  });

  it('is undefined from a client in another region, and for a name that is not plain', async () => {
    world({ [ORPHAN]: {} });
    clientRegion.value = 'us-west-2';
    await expect(provider.resourceIdentity(ORPHAN, TYPE, CTX)).resolves.toBeUndefined();
    clientRegion.value = 'us-east-1';
    await expect(provider.resourceIdentity('Not_Plain', TYPE, CTX)).resolves.toBeUndefined();
    await expect(provider.resourceIdentity(ORPHAN, 'AWS::SQS::Queue', CTX)).resolves.toBeUndefined();
    expect(sent()).toEqual([]);
  });
});
