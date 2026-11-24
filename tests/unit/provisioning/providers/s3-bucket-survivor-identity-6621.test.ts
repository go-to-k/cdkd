import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#6621: who holds a replaced bucket's old name, read when a
// deploy defers its delete and when a rollback is about to re-adopt it. A
// bucket this account's ListBuckets does not hold is someone else's; this
// account's bucket in the stack's region answers its `<region>|<CreationDate>`.

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
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { NoSuchBucket } from '@aws-sdk/client-s3';
import { S3BucketProvider } from '../../../../src/provisioning/providers/s3-bucket-provider.js';

const TYPE = 'AWS::S3::Bucket';
const OLD = 'stack-old-bucket';
const CREATED = new Date('2026-11-01T01:02:03.000Z');
const CTX = { expectedRegion: 'us-east-1' };

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const awsError = (name: string, status: number): Error =>
  Object.assign(new Error(name), { name, $fault: 'client', $metadata: { httpStatusCode: status } });

interface Bucket {
  /** Where GetBucketLocation says it lives, or the error it answers. */
  location?: string | Error;
  /** This account's ListBuckets entry: a date, or not listed. */
  listed?: Date | 'unlisted';
}

function world(buckets: Record<string, Bucket>, list?: Error): void {
  mockSend.mockImplementation((cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === 'GetBucketLocationCommand') {
      const b = buckets[cmd.input['Bucket'] as string];
      if (b === undefined) {
        return Promise.reject(
          new NoSuchBucket({ message: 'The specified bucket does not exist', $metadata: { httpStatusCode: 404 } })
        );
      }
      if (b.location instanceof Error) return Promise.reject(b.location);
      const region = b.location ?? 'us-east-1';
      return Promise.resolve({ LocationConstraint: region === 'us-east-1' ? null : region });
    }
    if (name === 'ListBucketsCommand') {
      if (list) return Promise.reject(list);
      const prefix = (cmd.input['Prefix'] as string | undefined) ?? '';
      return Promise.resolve({
        Buckets: Object.entries(buckets)
          .filter(([n, b]) => n.startsWith(prefix) && b.listed !== 'unlisted')
          .map(([Name, b]) => ({ Name, CreationDate: (b.listed as Date | undefined) ?? CREATED })),
      });
    }
    return Promise.resolve({});
  });
}

describe('S3BucketProvider.replacedSurvivorIdentity (go-to-k/cdkd#6621)', () => {
  let provider: S3BucketProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new S3BucketProvider();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const read = async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const pending = provider.replacedSurvivorIdentity(OLD, TYPE, CTX);
    await vi.runAllTimersAsync();
    return pending;
  };

  it("answers this account's bucket with its region and CreationDate", async () => {
    world({ [OLD]: {} });
    await expect(provider.replacedSurvivorIdentity(OLD, TYPE, CTX)).resolves.toEqual({
      kind: 'owned',
      identity: `us-east-1|${CREATED.toISOString()}`,
    });
  });

  it('carries no bucket name in the identity', async () => {
    world({ [OLD]: {} });
    const got = await provider.replacedSurvivorIdentity(OLD, TYPE, CTX);
    expect(JSON.stringify(got)).not.toContain(OLD);
  });

  it('matches the name exactly, not by prefix', async () => {
    world({ [OLD]: { listed: 'unlisted' }, [`${OLD}-2`]: {} });
    await expect(read()).resolves.toEqual({ kind: 'foreign', seen: 'other-account' });
  });

  it.each([
    ['located', {}],
    ['refused with AccessDenied (S3 on another account\'s bucket)', { location: awsError('AccessDenied', 403) }],
  ] as const)("is 'foreign' (other account) for a bucket %s that this account does not list", async (_l, b) => {
    world({ [OLD]: { ...b, listed: 'unlisted' } });
    await expect(read()).resolves.toEqual({ kind: 'foreign', seen: 'other-account' });
  });

  it("is 'foreign' (other region) for this account's bucket in another region", async () => {
    world({ [OLD]: { location: 'us-west-2' } });
    await expect(provider.replacedSurvivorIdentity(OLD, TYPE, CTX)).resolves.toEqual({
      kind: 'foreign',
      seen: 'other-region',
    });
  });

  it("is 'gone' when S3 has no bucket of that name", async () => {
    world({});
    await expect(provider.replacedSurvivorIdentity(OLD, TYPE, CTX)).resolves.toEqual({ kind: 'gone' });
  });

  it("is owned with no identity when this account lists it but its location cannot be read", async () => {
    world({ [OLD]: { location: awsError('AccessDenied', 403) } });
    await expect(provider.replacedSurvivorIdentity(OLD, TYPE, CTX)).resolves.toEqual({
      kind: 'owned',
      identity: undefined,
    });
  });

  it.each([
    ['the list fails', { [OLD]: {} }, awsError('ThrottlingException', 400)],
    ['an unlisted bucket whose location read is throttled', { [OLD]: { listed: 'unlisted', location: awsError('SlowDown', 503) } }, undefined],
  ] as const)("is 'unknown' when %s", async (_l, buckets, list) => {
    world(buckets as Record<string, Bucket>, list);
    await expect(read()).resolves.toEqual({ kind: 'unknown' });
  });

  it("is 'unknown', with no read, from a client in another region or for another type", async () => {
    world({ [OLD]: {} });
    clientRegion.value = 'us-west-2';
    await expect(provider.replacedSurvivorIdentity(OLD, TYPE, CTX)).resolves.toEqual({ kind: 'unknown' });
    clientRegion.value = 'us-east-1';
    await expect(provider.replacedSurvivorIdentity(OLD, 'AWS::SNS::Topic', CTX)).resolves.toEqual({
      kind: 'unknown',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("re-reads the list while it has not caught up, and answers the bucket it then shows", async () => {
    world({ [OLD]: {} });
    const answer = mockSend.getMockImplementation()!;
    let lists = 0;
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'ListBucketsCommand' && ++lists === 1) {
        return Promise.resolve({ Buckets: [] });
      }
      return answer(cmd);
    });
    await expect(read()).resolves.toEqual({ kind: 'owned', identity: `us-east-1|${CREATED.toISOString()}` });
    expect(lists).toBe(2);
  });

  it('answers no identity for an unreadable CreationDate', async () => {
    world({ [OLD]: { listed: new Date('not a date') } });
    await expect(provider.replacedSurvivorIdentity(OLD, TYPE, CTX)).resolves.toEqual({
      kind: 'owned',
      identity: undefined,
    });
  });
});

