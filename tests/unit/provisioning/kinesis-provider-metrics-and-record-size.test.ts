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
    // Guard against the vacuous read: without this, the `not.toHaveProperty`
    // below is satisfied by there being no CreateStreamCommand at all.
    expect(create).toBeDefined();
    expect(create?.input).not.toHaveProperty('MaxRecordSizeInKiB');
  });

  it('issues UpdateMaxRecordSize with the SUMMARY-resolved StreamARN when the value changes', async () => {
    // UpdateMaxRecordSize has no StreamName member, so the ARN lookup is
    // load-bearing rather than incidental.
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

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
    expect(cmds[0]?.input.StreamARN).toBe('arn:summary');
  });

  it('coerces a string-valued MaxRecordSizeInKiB rather than sending a JSON string', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    // CFn coerces scalars and cdkd does not, so an unquoted-YAML or
    // parameter-sourced value legitimately arrives as a string.
    await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      MaxRecordSizeInKiB: '2048',
    });

    expect(commandsOfType(CreateStreamCommand)[0]?.input.MaxRecordSizeInKiB).toBe(2048);
  });

  it('treats a string previous side and a number desired side as UNCHANGED', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', MaxRecordSizeInKiB: 2048 },
      { Name: 'mystream', MaxRecordSizeInKiB: '2048' }
    );

    // Without coercing BOTH sides this re-issues the call (and its ACTIVE wait)
    // on every single deploy.
    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
  });

  it.each([
    ['an unparseable string', 'not-a-number'],
    // Number('') === 0 and Number([]) === 0, so a bare Number() coercion would
    // send a plausible-looking 0; Number(true) === 1 likewise.
    ['an empty string', ''],
    ['an empty array', []],
    ['a boolean', true],
    ['an object', {}],
    ['an unresolved intrinsic', { Ref: 'SomeParam' }],
  ])('REFUSES %s for MaxRecordSizeInKiB rather than coercing it', async (_label, value) => {
    mockSend.mockResolvedValue(ACTIVE);

    await expect(
      provider.create('L', 'AWS::Kinesis::Stream', {
        Name: 'mystream',
        MaxRecordSizeInKiB: value,
      })
    ).rejects.toThrow(/MaxRecordSizeInKiB must be a number/);

    // And it must refuse BEFORE creating anything — see the pre-flight test below.
    expect(commandsOfType(CreateStreamCommand)).toHaveLength(0);
  });

  it('omits MaxRecordSizeInKiB on a state REPLAY rather than refusing the restore', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    const result = await provider.create(
      'L',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', MaxRecordSizeInKiB: 'not-a-number' },
      { replayingState: true }
    );

    expect(result.physicalId).toBe('mystream');
    const create = commandsOfType(CreateStreamCommand)[0];
    expect(create).toBeDefined();
    expect(create?.input).not.toHaveProperty('MaxRecordSizeInKiB');
  });

  it('WARNS rather than silently skipping when the UPDATE desired size is unusable', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', MaxRecordSizeInKiB: 'abc' },
      { Name: 'mystream', MaxRecordSizeInKiB: 2048 }
    );

    // Same junk value is a hard refusal on create; without the warn the update
    // path gives the user no signal at all that the property was ignored.
    expect(commandsOfType(UpdateMaxRecordSizeCommand)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/MaxRecordSizeInKiB must be a number/)
    );
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

  it('REFUSES an unresolved-intrinsic value on the template-path create', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    await expect(
      provider.create('L', 'AWS::Kinesis::Stream', {
        Name: 'mystream',
        DesiredShardLevelMetrics: { Ref: 'SomeParam' },
      })
    ).rejects.toThrow(/DesiredShardLevelMetrics must be an array of metric-name strings/);

    expect(commandsOfType(EnableEnhancedMonitoringCommand)).toHaveLength(0);
  });

  it('REFUSES a MIXED array rather than silently sending the string subset', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    // Filtering the intrinsic away would put a list on the wire the template
    // never declared while state recorded the declared one — phantom drift
    // through the back door.
    await expect(
      provider.create('L', 'AWS::Kinesis::Stream', {
        Name: 'mystream',
        DesiredShardLevelMetrics: ['IncomingBytes', { Ref: 'SomeParam' }],
      })
    ).rejects.toThrow(/DesiredShardLevelMetrics must be an array of metric-name strings/);

    expect(commandsOfType(EnableEnhancedMonitoringCommand)).toHaveLength(0);
  });

  it('DOWNGRADES the create refusal to a warning when replaying a state record', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    // The user cannot edit a state record from their CDK code, so refusing here
    // would leave the resource unrestorable (CreateContext.replayingState).
    const result = await provider.create(
      'L',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', DesiredShardLevelMetrics: { Ref: 'SomeParam' } },
      { replayingState: true }
    );

    expect(result.physicalId).toBe('mystream');
    expect(commandsOfType(EnableEnhancedMonitoringCommand)).toHaveLength(0);
  });

  it('does NOT disable live metrics when the UPDATE desired side is unusable', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', DesiredShardLevelMetrics: { Ref: 'SomeParam' } },
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'] }
    );

    // An UNUSABLE desired side must not collapse to the same empty list an
    // ABSENT one does: absent is a removal, unusable is unreadable, and
    // treating them alike destroys live monitoring on a value cdkd could not
    // parse. The update path warns and skips rather than refusing, because
    // rollback / drift --revert replay state records through update().
    expect(commandsOfType(DisableEnhancedMonitoringCommand)).toHaveLength(0);
    expect(commandsOfType(EnableEnhancedMonitoringCommand)).toHaveLength(0);
  });

  it('records the EXPANDED list as effectiveProperties on the UPDATE path too', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    // The create-path assertion does not cover this: switching an EXISTING
    // stream to `ALL` is exactly what the integ's Phase 2 does, and it is the
    // arm where a missing effectiveProperties leaves state describing a value
    // AWS does not hold.
    const result = await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', DesiredShardLevelMetrics: ['ALL'] },
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] }
    );

    const recorded = result.effectiveProperties?.['DesiredShardLevelMetrics'] as string[];
    expect(recorded).toBeDefined();
    expect(recorded).not.toContain('ALL');
    expect([...recorded].sort()).toEqual([...ALL_SEVEN].sort());
    expect(result.effectiveProperties?.['Name']).toBe('mystream');
  });

  it('omits effectiveProperties on the UPDATE path when no expansion happened', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    const result = await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes', 'OutgoingBytes'] },
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] }
    );

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('omits effectiveProperties when the UPDATE desired side was skipped as unusable', async () => {
    mockSend.mockResolvedValue({ ...ACTIVE, ...SUMMARY });

    const result = await provider.update(
      'L',
      'mystream',
      'AWS::Kinesis::Stream',
      { Name: 'mystream', DesiredShardLevelMetrics: 'IncomingBytes' as unknown as string[] },
      { Name: 'mystream', DesiredShardLevelMetrics: ['IncomingBytes'] }
    );

    // Nothing was sent, so there is no "what we actually delivered" to record;
    // the desired bag stays recorded verbatim and keeps re-warning until fixed.
    expect(result.effectiveProperties).toBeUndefined();
  });
});

describe('KinesisStreamProvider create-path PRE-FLIGHT (issue #609)', () => {
  let provider: KinesisStreamProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new KinesisStreamProvider();
  });

  // The refusal MUST run before the try block, not inside it. Refusing after
  // `CreateStream` has already landed leaves a real stream behind that the
  // failed CREATE never journals a physical id for, so `rollback-executor`
  // skips it: the stream is orphaned, absent from state, and — because the
  // generated name is a deterministic hash — the retry after the user fixes
  // the template collides with ResourceInUseException and wedges the stack.
  // See docs/provider-development.md §1a.
  // Each row is bound to its OWN message: with a bare `.rejects.toThrow()`
  // both rows pass when either branch throws the other property's error, so
  // one of the two pre-flights could be deleted undetected.
  it.each([
    [
      'DesiredShardLevelMetrics',
      { DesiredShardLevelMetrics: { Ref: 'P' } },
      /DesiredShardLevelMetrics must be an array of metric-name strings/,
    ],
    [
      'MaxRecordSizeInKiB',
      { MaxRecordSizeInKiB: { Ref: 'P' } },
      /MaxRecordSizeInKiB must be a number/,
    ],
    // The three FOLLOW-UP calls (issue #1710). Each of these values is only
    // consumed AFTER `CreateStream` — the tag loop, the retention change and
    // `StartStreamEncryption` — so before the pre-flight covered them a
    // malformed value threw against a stream AWS had already created, which is
    // exactly the orphan the block above exists to prevent.
    [
      'Tags (map-shaped instead of [{Key,Value}])',
      { Tags: { Env: 'prod' } },
      /Tags must be a list of \{Key, Value\} objects/,
    ],
    [
      'RetentionPeriodHours (non-numeric)',
      { RetentionPeriodHours: { Ref: 'P' } },
      /RetentionPeriodHours must be a number/,
    ],
    [
      'StreamEncryption KMS with no KeyId',
      { StreamEncryption: { EncryptionType: 'KMS' } },
      /StreamEncryption selects KMS but KeyId is not a non-empty string/,
    ],
  ])('issues NO AWS call at all when %s is unusable', async (_label, bad, expected) => {
    mockSend.mockResolvedValue(ACTIVE);

    await expect(
      provider.create('L', 'AWS::Kinesis::Stream', { Name: 'mystream', ...bad })
    ).rejects.toThrow(expected);

    // Not "no CreateStreamCommand" — NO send whatsoever. A refusal that ran
    // after any mutating call would already have leaked something.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still creates the stream fully when the template is valid', async () => {
    mockSend.mockResolvedValue(ACTIVE);

    const result = await provider.create('L', 'AWS::Kinesis::Stream', {
      Name: 'mystream',
      DesiredShardLevelMetrics: ['IncomingBytes'],
      MaxRecordSizeInKiB: 2048,
    });

    // Guards the inverse of the pre-flight: hoisting the checks must not have
    // short-circuited the happy path.
    expect(result.physicalId).toBe('mystream');
    expect(commandsOfType(CreateStreamCommand)[0]?.input.MaxRecordSizeInKiB).toBe(2048);
    expect(commandsOfType(EnableEnhancedMonitoringCommand)[0]?.input.ShardLevelMetrics).toEqual([
      'IncomingBytes',
    ]);
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
