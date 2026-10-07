import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const providerLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

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
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';

// go-to-k/cdkd#4655: the token a failed CREATE journals beside a stream name,
// compared again before a successful deploy deletes the stream. The ARN is
// built from the name, so the creation timestamp is what tells a re-created
// stream from the one the failed CREATE made.

const TYPE = 'AWS::Kinesis::Stream';
const CTX = { expectedRegion: 'us-east-1' };
const ARN = 'arn:aws:kinesis:us-east-1:123456789012:stream/s';

function answer(summary: Record<string, unknown> | Error): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof DescribeStreamSummaryCommand)) throw new Error('unexpected command');
    if (summary instanceof Error) throw summary;
    return { StreamDescriptionSummary: summary };
  });
}

describe('KinesisStreamProvider.resourceIdentity (go-to-k/cdkd#4655)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new KinesisStreamProvider();
  });

  it('is the ARN and the creation time, which differ for a stream re-created under the same name', async () => {
    answer({ StreamARN: ARN, StreamCreationTimestamp: new Date(1700000000000) });
    const first = await provider.resourceIdentity('s', TYPE, CTX);
    expect(first).toBe(`${ARN}@1700000000000`);
    expect((mockSend.mock.calls[0]![0] as DescribeStreamSummaryCommand).input.StreamName).toBe('s');
    answer({ StreamARN: ARN, StreamCreationTimestamp: new Date(1700000005000) });
    const recreated = await provider.resourceIdentity('s', TYPE, CTX);
    expect(recreated).not.toBe(first);
  });

  it('is RESOURCE_NOT_FOUND only on AWS not-found; any other failure throws', async () => {
    answer(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
    expect(await provider.resourceIdentity('s', TYPE, CTX)).toBe(RESOURCE_NOT_FOUND);
    answer(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await expect(provider.resourceIdentity('s', TYPE, CTX)).rejects.toThrow('denied');
  });

  it.each([
    ['no creation timestamp', { StreamARN: ARN }],
    ['an invalid creation timestamp', { StreamARN: ARN, StreamCreationTimestamp: new Date(NaN) }],
    ['no ARN', { StreamCreationTimestamp: new Date(1) }],
    ['an empty ARN', { StreamARN: '', StreamCreationTimestamp: new Date(1) }],
  ])('names nothing for a response with %s', async (_label, summary) => {
    answer(summary);
    expect(await provider.resourceIdentity('s', TYPE, CTX)).toBeUndefined();
  });

  it('names nothing, without a read, for an ARN or a client in another region', async () => {
    answer({ StreamARN: ARN, StreamCreationTimestamp: new Date(1) });
    expect(await provider.resourceIdentity(ARN, TYPE, CTX)).toBeUndefined();
    clientRegion.value = 'eu-west-1';
    expect(await provider.resourceIdentity('s', TYPE, CTX)).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
