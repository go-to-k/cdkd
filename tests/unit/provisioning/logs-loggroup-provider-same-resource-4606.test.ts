/**
 * go-to-k/cdkd#4606 / #4655, the CloudWatch Logs log group slice:
 * `LogsLogGroupProvider.isSameResource` (is the log group a failed CREATE
 * journaled the one the record under the same logical id holds?) and
 * `resourceIdentity` (`<logGroupArn>@<creationTime>`, the token a fix-forward
 * settle compares before deleting a name-keyed orphan). Every case the read
 * cannot prove answers `unknown` / `undefined`, never `different` / a token.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ResourceNotFoundException } from '@aws-sdk/client-cloudwatch-logs';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { orphanDeleteNeedsIdentity } from '../../../src/deployment/rollback-executor/orphan-identity.js';

const TYPE = 'AWS::Logs::LogGroup';
const REGION = { expectedRegion: 'us-east-1' };
const JOURNALED = '/cdkd/fix-forward/orphan-a';
const RECORD = '/cdkd/fix-forward/orphan-a-b';
const arnOf = (name: string): string =>
  `arn:aws:logs:us-east-1:123456789012:log-group:${name}`;

/** A `DescribeLogGroups` entry; an explicit `undefined` leaves the field absent. */
function group(name: string, ...overrides: [creationTime?: unknown, arn?: unknown]) {
  const creationTime = overrides.length >= 1 ? overrides[0] : 1760000000123;
  const arn = overrides.length >= 2 ? overrides[1] : arnOf(name);
  return { logGroupName: name, logGroupArn: arn, arn: `${String(arn)}:*`, creationTime };
}
function listing(...groups: unknown[]) {
  return { logGroups: groups };
}
function notFound() {
  return new ResourceNotFoundException({ message: 'The specified log group does not exist.', $metadata: {} });
}
function accessDenied() {
  return Object.assign(new Error('User is not authorized to perform: logs:DescribeLogGroups'), {
    name: 'AccessDeniedException',
    $metadata: { httpStatusCode: 400 },
  });
}
/** The `logGroupNamePrefix` of every `DescribeLogGroups` sent, in order. */
function describedPrefixes(): unknown[] {
  return mockSend.mock.calls.map((c) => {
    expect(c[0].constructor.name).toBe('DescribeLogGroupsCommand');
    return c[0].input.logGroupNamePrefix;
  });
}

describe('LogsLogGroupProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new LogsLogGroupProvider();
  });

  it('answers different when both read back under their own names', async () => {
    mockSend.mockResolvedValueOnce(listing(group(RECORD)));
    mockSend.mockResolvedValueOnce(listing(group(JOURNALED)));
    await expect(provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)).resolves.toBe(
      'different'
    );
    // The record's log group is read first, then the journaled one.
    expect(describedPrefixes()).toEqual([RECORD, JOURNALED]);
  });

  it('answers different when the journaled log group is not listed (gone)', async () => {
    mockSend.mockResolvedValueOnce(listing(group(RECORD)));
    mockSend.mockResolvedValueOnce(listing());
    await expect(provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)).resolves.toBe(
      'different'
    );
  });

  it('answers different when the journaled read is ResourceNotFoundException', async () => {
    mockSend.mockResolvedValueOnce(listing(group(RECORD)));
    mockSend.mockRejectedValueOnce(notFound());
    await expect(provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)).resolves.toBe(
      'different'
    );
  });

  it('a prefix match is not the journaled log group: only its exact name is', async () => {
    // `/cdkd/fix-forward/orphan-a` prefixes the record's own name: the listing
    // of the journaled prefix shows only the record's group.
    mockSend.mockResolvedValueOnce(listing(group(RECORD)));
    mockSend.mockResolvedValueOnce(listing(group(RECORD)));
    await expect(provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)).resolves.toBe(
      'different'
    );
  });

  it('answers unknown when the record log group does not read back (never different)', async () => {
    mockSend.mockResolvedValueOnce(listing());
    await expect(provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('answers unknown when only a longer name under the record prefix is listed', async () => {
    mockSend.mockResolvedValueOnce(listing(group(`${RECORD}-other`)));
    await expect(provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)).resolves.toBe(
      'unknown'
    );
  });

  it('answers same for equal names without a read', async () => {
    await expect(
      provider.isSameResource(JOURNALED, { physicalId: JOURNALED }, TYPE, REGION)
    ).resolves.toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('answers unknown for names differing only in case, without a read', async () => {
    await expect(
      provider.isSameResource('/cdkd/Orphan', { physicalId: '/cdkd/orphan' }, TYPE, REGION)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('answers unknown for another resource type, without a read', async () => {
    await expect(
      provider.isSameResource(JOURNALED, { physicalId: RECORD }, 'AWS::Logs::LogStream', REGION)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an ARN as the journaled id', arnOf(JOURNALED), RECORD],
    ['an ARN as the record id', JOURNALED, `${arnOf(RECORD)}:*`],
    ['an empty journaled id', '', RECORD],
    ['a name with a space', '/cdkd/has space', RECORD],
    ['a name over 512 characters', `/${'a'.repeat(512)}`, RECORD],
  ])('answers unknown for %s, without a read', async (_label, journaled, record) => {
    await expect(provider.isSameResource(journaled, { physicalId: record }, TYPE, REGION)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('answers unknown when the client is in another region than the stack, without a read', async () => {
    await expect(
      provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, { expectedRegion: 'us-west-2' })
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws (read as unknown by the caller) when the record read fails', async () => {
    mockSend.mockRejectedValueOnce(accessDenied());
    await expect(
      provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).rejects.toThrow(/not authorized/);
  });

  it('throws when the journaled read fails with anything but not-found', async () => {
    mockSend.mockResolvedValueOnce(listing(group(RECORD)));
    mockSend.mockRejectedValueOnce(accessDenied());
    await expect(
      provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).rejects.toThrow(/not authorized/);
  });

  it('throws when a listed log group carries no logGroupArn', async () => {
    mockSend.mockResolvedValueOnce(listing(group(RECORD, 1760000000123, undefined)));
    await expect(
      provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).rejects.toThrow(/no logGroupArn/);
  });
});

describe('LogsLogGroupProvider.resourceIdentity (go-to-k/cdkd#4655 / #4606)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new LogsLogGroupProvider();
  });

  it('is the log group ARN and its creation time', async () => {
    mockSend.mockResolvedValueOnce(listing(group(JOURNALED, 1760000000123)));
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(
      `${arnOf(JOURNALED)}@1760000000123`
    );
    expect(describedPrefixes()).toEqual([JOURNALED]);
  });

  it('differs for a log group re-created under the same name', async () => {
    mockSend.mockResolvedValueOnce(listing(group(JOURNALED, 1760000000123)));
    mockSend.mockResolvedValueOnce(listing(group(JOURNALED, 1760000099456)));
    const first = await provider.resourceIdentity(JOURNALED, TYPE, REGION);
    const second = await provider.resourceIdentity(JOURNALED, TYPE, REGION);
    expect(typeof first).toBe('string');
    expect(typeof second).toBe('string');
    expect(second).not.toBe(first);
  });

  it('picks the exact name out of a prefix listing', async () => {
    mockSend.mockResolvedValueOnce(
      listing(group(JOURNALED, 1760000000123), group(`${JOURNALED}-b`, 1760000000999))
    );
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(
      `${arnOf(JOURNALED)}@1760000000123`
    );
  });

  it('is RESOURCE_NOT_FOUND when the exact name is not listed', async () => {
    mockSend.mockResolvedValueOnce(listing(group(`${JOURNALED}-b`)));
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it('throws, never RESOURCE_NOT_FOUND, when a first page without the name has more pages', async () => {
    mockSend.mockResolvedValueOnce({ ...listing(group(`${JOURNALED}-b`)), nextToken: 'more' });
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).rejects.toThrow(/more pages/);
    // The same read in isSameResource: an unreadable journaled group is never 'different'.
    mockSend.mockResolvedValueOnce(listing(group(RECORD)));
    mockSend.mockResolvedValueOnce({ logGroups: [], nextToken: 'more' });
    await expect(
      provider.isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).rejects.toThrow(/more pages/);
  });

  it('a first page holding the name answers even with more pages', async () => {
    mockSend.mockResolvedValueOnce({ ...listing(group(JOURNALED, 1760000000123)), nextToken: 'more' });
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(
      `${arnOf(JOURNALED)}@1760000000123`
    );
  });

  it('is RESOURCE_NOT_FOUND on an empty listing and on ResourceNotFoundException', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(RESOURCE_NOT_FOUND);
    mockSend.mockRejectedValueOnce(notFound());
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1760000000123.5],
    ['a string', '1760000000123'],
    ['NaN', Number.NaN],
  ])('is undefined when the creation time is %s', async (_label, creationTime) => {
    mockSend.mockResolvedValueOnce(listing(group(JOURNALED, creationTime)));
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBeUndefined();
  });

  it('throws when the listed log group carries no logGroupArn', async () => {
    mockSend.mockResolvedValueOnce(listing(group(JOURNALED, 1760000000123, '')));
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).rejects.toThrow(/no logGroupArn/);
  });

  it('throws on any other read failure ("could not read" is never "gone")', async () => {
    mockSend.mockRejectedValueOnce(accessDenied());
    await expect(provider.resourceIdentity(JOURNALED, TYPE, REGION)).rejects.toThrow(/not authorized/);
  });

  it.each([
    ['another resource type', JOURNALED, 'AWS::Logs::LogStream', REGION],
    ['an ARN', `${arnOf(JOURNALED)}:*`, TYPE, REGION],
    ['a client in another region', JOURNALED, TYPE, { expectedRegion: 'eu-west-1' }],
  ])('is undefined for %s, without a read', async (_label, id, type, ctx) => {
    await expect(provider.resourceIdentity(id, type, ctx)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is required for a log group orphan: the settle compares it before a delete', () => {
    expect(orphanDeleteNeedsIdentity(TYPE)).toBe(true);
  });
});

describe('LogsLogGroupProvider failed-CREATE mark and gone delete (go-to-k/cdkd#4606)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    childLogger.info.mockReset();
    childLogger.debug.mockReset();
    provider = new LogsLogGroupProvider();
  });

  it('marks the name with no carried identity: the engine reads resourceIdentity when it journals', async () => {
    mockSend.mockResolvedValueOnce({}); // CreateLogGroup
    mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy denied'));
    mockSend.mockRejectedValueOnce(new Error('DeleteLogGroup denied'));
    let thrown: unknown;
    try {
      await provider.create('OrphanA', TYPE, { LogGroupName: JOURNALED, RetentionInDays: 7 });
    } catch (error) {
      thrown = error;
    }
    expect(createdBeforeFailure(thrown, 'OrphanA', TYPE)).toBe(JOURNALED);
    // CreateLogGroup answers with no creation time, so no token rides the
    // mark and the create sends no extra read on its success path either.
    expect(createdResourceIdentityBeforeFailure(thrown, 'OrphanA', TYPE)).toBeUndefined();
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toEqual([
      'CreateLogGroupCommand',
      'PutRetentionPolicyCommand',
      'DeleteLogGroupCommand',
    ]);
  });

  it("says a failed CREATE's orphan already gone at info", async () => {
    mockSend.mockRejectedValueOnce(notFound());
    await provider.delete('OrphanA', JOURNALED, TYPE, undefined, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    expect(childLogger.info).toHaveBeenCalledTimes(1);
    expect(String(childLogger.info.mock.calls[0]?.[0])).toContain(
      `Log group ${JOURNALED} (OrphanA), which a failed deploy created, is already gone`
    );
  });

  it('keeps an ordinary gone delete at debug', async () => {
    mockSend.mockRejectedValueOnce(notFound());
    await provider.delete('OrphanA', JOURNALED, TYPE, undefined, { expectedRegion: 'us-east-1' });
    expect(childLogger.info).not.toHaveBeenCalled();
    expect(childLogger.debug).toHaveBeenCalledWith(
      `Log group ${JOURNALED} does not exist, skipping deletion`
    );
  });
});
