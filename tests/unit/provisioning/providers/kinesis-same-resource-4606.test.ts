import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

import { DescribeStreamSummaryCommand, ResourceNotFoundException } from '@aws-sdk/client-kinesis';
import { KinesisStreamProvider } from '../../../../src/provisioning/providers/kinesis-provider.js';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier stream. Only `'different'` lets it delete.

const TYPE = 'AWS::Kinesis::Stream';
const CTX = { expectedRegion: 'us-east-1' };
const arnOf = (name: string): string => `arn:aws:kinesis:us-east-1:123456789012:stream/${name}`;
const notFound = (): ResourceNotFoundException =>
  new ResourceNotFoundException({ message: 'not found', $metadata: {} });

/** `DescribeStreamSummary` answers per stream name: an ARN, or gone. */
function streams(live: Record<string, string | 'gone' | Error>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeStreamSummaryCommand)) throw new Error('unexpected command');
    const name = cmd.input.StreamName!;
    const entry = live[name];
    if (entry === undefined || entry === 'gone') throw notFound();
    if (entry instanceof Error) throw entry;
    return { StreamDescriptionSummary: { StreamName: name, StreamARN: entry } };
  });
}

describe('KinesisStreamProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new KinesisStreamProvider();
  });

  it('another live stream under another ARN is different', async () => {
    streams({ a: arnOf('a'), b: arnOf('b') });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('different');
    // Both were read: the record's first, then the journaled one.
    expect(mockSend.mock.calls.map(([c]) => (c as DescribeStreamSummaryCommand).input.StreamName)).toEqual([
      'b',
      'a',
    ]);
  });

  it('a journaled name AWS reports gone is different once the record reads back', async () => {
    streams({ a: 'gone', b: arnOf('b') });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('different');
  });

  it('another spelling that reads back under the record ARN is the same stream', async () => {
    streams({ A: arnOf('a'), a: arnOf('a') });
    expect(await provider.isSameResource('A', { physicalId: 'a' }, TYPE, CTX)).toBe('same');
  });

  it('equal names are the same without a read (the name now names the record stream)', async () => {
    streams({});
    expect(await provider.isSameResource('a', { physicalId: 'a' }, TYPE, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the record stream gone is unknown, not different', async () => {
    streams({ a: arnOf('a'), b: 'gone' });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    streams({ a: denied, b: arnOf('b') });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow('denied');
  });

  it('a response naming no ARN throws rather than reading as gone', async () => {
    mockSend.mockResolvedValue({ StreamDescriptionSummary: {} });
    await expect(provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).rejects.toThrow(
      'no StreamARN'
    );
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    streams({ a: 'gone', b: arnOf('b') });
    expect(await provider.isSameResource('a', { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an id that is not a stream name (an ARN, an empty id) is unknown, with no read', async () => {
    streams({ a: 'gone', b: arnOf('b') });
    expect(await provider.isSameResource(arnOf('a'), { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
    expect(await provider.isSameResource('a', { physicalId: arnOf('b') }, TYPE, CTX)).toBe('unknown');
    expect(await provider.isSameResource('', { physicalId: 'b' }, TYPE, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
