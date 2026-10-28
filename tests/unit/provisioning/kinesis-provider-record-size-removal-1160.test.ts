import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateMaxRecordSizeCommand } from '@aws-sdk/client-kinesis';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kinesis', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-kinesis')>(
    '@aws-sdk/client-kinesis'
  );
  return {
    ...actual,
    KinesisClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs —
// a plain `const warnSpy = vi.fn()` above the mock is still in the temporal
// dead zone when the factory is invoked.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';

const ACTIVE = {
  StreamDescription: { StreamName: 'mystream', StreamStatus: 'ACTIVE', StreamARN: 'arn:describe' },
};
// A DISTINCT ARN from the DescribeStream one on purpose: `UpdateMaxRecordSize`
// must source its `StreamARN` from `resolveStreamArn` (DescribeStreamSummary).
// With both fixtures carrying the same string, reading the wrong response field
// would be undetectable.
const SUMMARY = { StreamDescriptionSummary: { StreamARN: 'arn:summary', OpenShardCount: 1 } };

function commandsOfType<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

const TYPE = 'AWS::Kinesis::Stream';

// CFn A/B (us-east-1): a stream created with MaxRecordSizeInKiB 2048 read back
// 1024 after a CloudFormation update that removed the property, both alone and
// beside a RetentionPeriodHours change.
describe('KinesisStreamProvider MaxRecordSizeInKiB removal (go-to-k/cdkd#1160)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });
    provider = new KinesisStreamProvider();
  });

  it('removed: dropping a non-default size resets it to 1024', async () => {
    await provider.update('L', 'mystream', TYPE, { Name: 'mystream' }, { Name: 'mystream', MaxRecordSizeInKiB: 2048 });

    const cmds = commandsOfType(UpdateMaxRecordSizeCommand);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.input.MaxRecordSizeInKiB).toBe(1024);
    expect(cmds[0]?.input.StreamARN).toBe('arn:summary');
  });

  it('removed: a numeric-string previous size resets too', async () => {
    await provider.update('L', 'mystream', TYPE, { Name: 'mystream' }, { Name: 'mystream', MaxRecordSizeInKiB: '4096' });

    expect(commandsOfType(UpdateMaxRecordSizeCommand)[0]?.input.MaxRecordSizeInKiB).toBe(1024);
  });

  it('removed: a previous size already at the default issues no call', async () => {
    await provider.update('L', 'mystream', TYPE, { Name: 'mystream' }, { Name: 'mystream', MaxRecordSizeInKiB: 1024 });

    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
  });

  it('never-present: no size on either side issues no call', async () => {
    await provider.update('L', 'mystream', TYPE, { Name: 'mystream' }, { Name: 'mystream' });

    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
  });

  it('kept: a declared size equal to the previous one issues no call', async () => {
    const props = { Name: 'mystream', MaxRecordSizeInKiB: 2048 };

    await provider.update('L', 'mystream', TYPE, props, props);

    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
  });

  it('added: a size declared over a previous ABSENT one is sent', async () => {
    await provider.update('L', 'mystream', TYPE, { Name: 'mystream', MaxRecordSizeInKiB: 2048 }, { Name: 'mystream' });

    expect(commandsOfType(UpdateMaxRecordSizeCommand)[0]?.input.MaxRecordSizeInKiB).toBe(2048);
  });

  it('an unusable PREVIOUS side reads as the default, so a removal issues no call', async () => {
    await provider.update('L', 'mystream', TYPE, { Name: 'mystream' }, { Name: 'mystream', MaxRecordSizeInKiB: 'abc' });

    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
  });

  it('an unusable DESIRED side is not a removal: it warns and keeps the live size', async () => {
    await provider.update(
      'L',
      'mystream',
      TYPE,
      { Name: 'mystream', MaxRecordSizeInKiB: { Ref: 'P' } },
      { Name: 'mystream', MaxRecordSizeInKiB: 2048 }
    );

    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/MaxRecordSizeInKiB must be a number/));
  });

  it('rollback replay: reverting to a state without the size resets it', async () => {
    await provider.update(
      'L',
      'mystream',
      TYPE,
      { Name: 'mystream' },
      { Name: 'mystream', MaxRecordSizeInKiB: 8192 },
      { replayingState: true }
    );

    expect(commandsOfType(UpdateMaxRecordSizeCommand)[0]?.input.MaxRecordSizeInKiB).toBe(1024);
  });
});
