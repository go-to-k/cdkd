import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateStreamCommand,
  DisableEnhancedMonitoringCommand,
  EnableEnhancedMonitoringCommand,
  UpdateMaxRecordSizeCommand,
} from '@aws-sdk/client-kinesis';

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

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';

const ACTIVE = {
  StreamDescription: { StreamName: 'mystream', StreamStatus: 'ACTIVE', StreamARN: 'arn:s' },
};
const SUMMARY = { StreamDescriptionSummary: { StreamARN: 'arn:s', OpenShardCount: 1 } };

/** The seven names AWS expands `ALL` into (measured us-east-1, 2026-08-12). */
const ALL_SEVEN = [
  'IncomingBytes',
  'IncomingRecords',
  'OutgoingBytes',
  'OutgoingRecords',
  'WriteProvisionedThroughputExceeded',
  'ReadProvisionedThroughputExceeded',
  'IteratorAgeMilliseconds',
];

function commandsOfType<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
}

describe('KinesisStreamProvider MaxRecordSizeInKiB (issue #609)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new KinesisStreamProvider();
  });

  it('passes MaxRecordSizeInKiB on CreateStream', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      MaxRecordSizeInKiB: 2048,
    });

    const create = commandsOfType(CreateStreamCommand)[0];
    expect(create?.input.MaxRecordSizeInKiB).toBe(2048);
  });

  it('omits MaxRecordSizeInKiB from CreateStream when the template does not declare it', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await provider.create('L', 'AWS::Kinesis::Stream', { Name: 'mystream' });

    const create = commandsOfType(CreateStreamCommand)[0];
    expect(create?.input).not.toHaveProperty('MaxRecordSizeInKiB');
  });

  it('issues UpdateMaxRecordSize with the resolved StreamARN when the value changes', async () => {
    // UpdateMaxRecordSize has no StreamName member, so the ARN lookup is
    // load-bearing rather than incidental.
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof UpdateMaxRecordSizeCommand) return Promise.resolve({});
      if ((cmd as { input?: unknown }) && 'StreamName' in ((cmd as never)['input'] ?? {})) {
        return Promise.resolve({ ...ACTIVE, ...SUMMARY });
      }
      return Promise.resolve({ ...ACTIVE, ...SUMMARY });
    });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', MaxRecordSizeInKiB: 4096 },
      { Name: 'mystream', MaxRecordSizeInKiB: 1024 }
    );

    const cmds = commandsOfType(UpdateMaxRecordSizeCommand);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.input.MaxRecordSizeInKiB).toBe(4096);
    expect(cmds[0]?.input.StreamARN).toBe('arn:s');
  });

  it('does not issue UpdateMaxRecordSize when the value is unchanged', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', MaxRecordSizeInKiB: 1024 },
      { Name: 'mystream', MaxRecordSizeInKiB: 1024 }
    );

    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
  });
});

describe('KinesisStreamProvider DesiredShardLevelMetrics (issue #609)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new KinesisStreamProvider();
  });

  it('enables the declared metrics on create', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'],
    });

    const cmds = commandsOfType(EnableEnhancedMonitoringCommand);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]?.input.ShardLevelMetrics).toEqual(['IncomingBytes', 'OutgoingBytes']);
  });

  it('makes no enhanced-monitoring call when the template declares none', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await provider.create('L', 'AWS::Kinesis::Stream', { Name: 'mystream' });

    expect(commandsOfType(EnableEnhancedMonitoringCommand)).toHaveLength(0);
  });

  it('EXPANDS ALL on the wire — AWS never stores the literal, so sending it would be unmatched by any readback', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: ['ALL'],
    });

    const sent = commandsOfType(EnableEnhancedMonitoringCommand)[0]?.input.ShardLevelMetrics;
    expect(sent).not.toContain('ALL');
    expect([...(sent ?? [])].sort()).toEqual([...ALL_SEVEN].sort());
  });

  it('records the EXPANDED list as effectiveProperties so state describes what AWS holds', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    const result = await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: ['ALL'],
    });

    const recorded = result.effectiveProperties?.['DesiredShardLevelMetrics'] as string[];
    expect(recorded).not.toContain('ALL');
    expect([...recorded].sort()).toEqual([...ALL_SEVEN].sort());
    // A COMPLETE replacement, not a patch — the rest of the desired bag survives.
    expect(result.effectiveProperties?.['Name']).toBe('mystream');
  });

  it('omits effectiveProperties entirely when no expansion happened', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    const result = await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: ['IncomingBytes'],
    });

    // Absent means "record the desired bag verbatim"; returning a copy would
    // work but would mask a future expansion regression behind a always-set field.
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('dedupes so ALL plus an explicit sibling does not send the metric twice', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: ['IncomingBytes', 'ALL'],
    });

    const sent = commandsOfType(EnableEnhancedMonitoringCommand)[0]?.input.ShardLevelMetrics ?? [];
    expect(new Set(sent).size).toBe(sent.length);
    expect([...sent].sort()).toEqual([...ALL_SEVEN].sort());
  });

  it('applies the update as a disable pass then an enable pass', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes', 'IteratorAgeMilliseconds'] },
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'] }
    );

    expect(commandsOfType(DisableEnhancedMonitoringCommand)[0]?.input.ShardLevelMetrics).toEqual([
      'OutgoingBytes',
    ]);
    expect(commandsOfType(EnableEnhancedMonitoringCommand)[0]?.input.ShardLevelMetrics).toEqual([
      'IteratorAgeMilliseconds',
    ]);
  });

  it('treats a switch between ALL and the seven explicit names as a NO-OP', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', DesiredShardLevelMetrics: ALL_SEVEN },
      { Name: 'mystream', DesiredShardLevelMetrics: ['ALL'] }
    );

    // Both sides expand first, so the churn the naive diff would produce
    // (disable seven, enable seven) never happens.
    expect(commandsOfType(DisableEnhancedMonitoringCommand)).toHaveLength(0);
    expect(commandsOfType(EnableEnhancedMonitoringCommand)).toHaveLength(0);
  });

  it('disables every metric when the template drops the property', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream' },
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] }
    );

    expect(commandsOfType(DisableEnhancedMonitoringCommand)[0]?.input.ShardLevelMetrics).toEqual([
      'IncomingBytes',
    ]);
  });

  it('does not refuse a malformed PREVIOUS side (it comes from state, not the template)', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await expect(
      provider.update(
        'L',
        'mystream',
        'AWS::Kinesis::Stream',
        { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] },
        { Name: 'mystream', DesiredShardLevelMetrics: 'IncomingBytes' as unknown as string[] }
      )
    ).resolves.toBeDefined();

    // The unreadable previous side contributes nothing, so the desired metric
    // is simply enabled rather than the update being blocked.
    expect(commandsOfType(EnableEnhancedMonitoringCommand)[0]?.input.ShardLevelMetrics).toEqual([
      'IncomingBytes',
    ]);
  });

  it('sends no metrics call for an unresolved-intrinsic value rather than inventing a list', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: { Ref: 'SomeParam' },
    });

    expect(commandsOfType(EnableEnhancedMonitoringCommand)).toHaveLength(0);
  });
});

describe('KinesisStreamProvider.canonicalizeDesiredProperties (issue #609)', () => {
  const provider = new KinesisStreamProvider();

  it('expands ALL the same way the wire path does, so the diff compares like for like', () => {
    const out = provider.canonicalizeDesiredProperties('AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: ['ALL'],
    });

    expect([...(out['DesiredShardLevelMetrics'] as string[])].sort()).toEqual(
      [...ALL_SEVEN].sort()
    );
  });

  it('is IDEMPOTENT — an already-expanded state-borne bag is returned unchanged', () => {
    const already = { Name: 'mystream', DesiredShardLevelMetrics: ALL_SEVEN };
    expect(provider.canonicalizeDesiredProperties('AWS::Kinesis::Stream', already)).toBe(already);
  });

  it('returns the input unchanged when the property is absent', () => {
    const bag = { Name: 'mystream' };
    expect(provider.canonicalizeDesiredProperties('AWS::Kinesis::Stream', bag)).toBe(bag);
  });

  it('leaves other resource types alone', () => {
    const bag = { DesiredShardLevelMetrics: ['ALL'] };
    expect(provider.canonicalizeDesiredProperties('AWS::SQS::Queue', bag)).toBe(bag);
  });

  it('agrees with the provisioning path key-for-key (the shared-helper contract)', async () => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockSend.mockResolvedValue(ACTIVE);

    const declared = { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes', 'ALL'] };
    const created = await new KinesisStreamProvider().create(
      'L',
      'AWS::Kinesis::Stream',
      declared
    );
    const canonicalized = provider.canonicalizeDesiredProperties(
      'AWS::Kinesis::Stream',
      declared
    );

    // State (effectiveProperties) and the diff (canonicalize) must narrow to
    // the SAME list, or the next deploy reads the difference as a user change.
    expect(created.effectiveProperties?.['DesiredShardLevelMetrics']).toEqual(
      canonicalized['DesiredShardLevelMetrics']
    );
  });
});

describe('KinesisStreamProvider.getDriftUnorderedPaths (issue #609)', () => {
  const provider = new KinesisStreamProvider();

  it('declares DesiredShardLevelMetrics unordered (AWS returns an arbitrary order)', () => {
    expect(provider.getDriftUnorderedPaths('AWS::Kinesis::Stream')).toEqual([
      'DesiredShardLevelMetrics',
    ]);
  });

  it('declares nothing for other types', () => {
    expect(provider.getDriftUnorderedPaths('AWS::SQS::Queue')).toEqual([]);
  });
});
